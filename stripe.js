import express from "express";
import Stripe from "stripe";
import bodyParser from "body-parser";
// Firebase
import { db } from "./firebase.js";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import dotenv from 'dotenv';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // ✅ Read from env

const app = express();
app.use(express.json());

// ------------------- Test Endpoint -------------------
// ------------------- Test Endpoint -------------------
app.get("/hello", (req, res) => {
  console.log("Stripe key:", process.env.STRIPE_SECRET_KEY);
  res.json({
    message: "Hello! The server is running with full potential 🚀",
    stripeKey: process.env.STRIPE_SECRET_KEY // ⚠️ remove if you don’t want to expose your secret key
  });
});

// ------------------- 1️⃣ Create Connected Account -------------------
app.post("/create-connectId", async (req, res) => {
  console.log("📩 [Backend] /create-connectId called with body:", req.body);

  const { userId, email } = req.body;

  if (!userId || !email) {
    console.log("❌ Missing userId or email");
    return res.status(400).json({ error: "userId and email are required" });
  }

  try {
    const ambassadorRef = doc(db, "ambassadors", userId);
    const ambassadorSnap = await getDoc(ambassadorRef);

    if (!ambassadorSnap.exists()) {
      console.log("❌ Ambassador not found in Firestore:", userId);
      return res.status(404).json({ error: "Ambassador not found" });
    }

    // ✅ Create Stripe account
    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      email,
      capabilities: { transfers: { requested: true } },
      metadata: { ambassadorId: userId },
    });

    console.log("✅ Stripe account created:", account);

    // 🔹 Prepare Firestore object to match Stripe structure
    const stripeData = {
      connectAccountId: account.id,
      onboardingCompleted: account.details_submitted || false,
      chargesEnabled: account.charges_enabled || false,
      payoutsEnabled: account.payouts_enabled || false,
      disabledReason: account.requirements?.disabled_reason || null,
      currentlyDue: account.requirements?.currently_due || [],
      eventuallyDue: account.requirements?.eventually_due || [],
      pastDue: account.requirements?.past_due || [],
      stripeOnboardingUrl: null, // Will be updated when onboarding link is created
    };

    await updateDoc(ambassadorRef, { stripe: stripeData });

    console.log("✅ Firestore updated for ambassador:", userId);

    res.json({
      message: "Connect account created",
      connectAccountId: account.id,
    });
  } catch (err) {
    console.error("🔥 Error in /create-connectId:", err);
    res.status(500).json({ error: err.message });
  }
});


// ------------------- 2️⃣ Generate Onboarding Link -------------------
// ------------------- 2️⃣ Generate Onboarding Link -------------------
app.post("/onboarding-link", async (req, res) => {
  const { userId, connectAccountId } = req.body;

  if (!userId || !connectAccountId) {
    return res.status(400).json({ error: "userId and connectAccountId are required" });
  }

  try {
    // ✅ Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: connectAccountId,
      refresh_url: "https://stripe-production-af7d.up.railway.app/reauth",  // 🔧 update in production
      return_url: "https://stripe-production-af7d.up.railway.app/success",  // 🔧 update in production
      type: "account_onboarding",
    });

    // ✅ Fetch latest account details from Stripe
    const account = await stripe.accounts.retrieve(connectAccountId);

    console.log("✅ Stripe account fetched for onboarding update:", account.id);

    // 🔹 Prepare Firestore object to match Stripe structure
    const stripeData = {
      stripeOnboardingUrl: accountLink.url,
      connectAccountId: account.id,
      onboardingCompleted: account.details_submitted || false,
      chargesEnabled: account.charges_enabled || false,
      payoutsEnabled: account.payouts_enabled || false,
      disabledReason: account.requirements?.disabled_reason || null,
      currentlyDue: account.requirements?.currently_due || [],
      eventuallyDue: account.requirements?.eventually_due || [],
      pastDue: account.requirements?.past_due || [],
    };

    // ✅ Save updated stripe status in Firestore
    const ambassadorRef = doc(db, "ambassadors", userId);
    await updateDoc(ambassadorRef, { stripe: stripeData });

    console.log("✅ Firestore updated with onboarding link for ambassador:", userId);

    res.json({
      message: "Onboarding link generated",
      onboardingUrl: accountLink.url,
    });
  } catch (err) {
    console.error("🔥 Error generating onboarding link:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/success", (req, res) => {
  res.send("🎉 Onboarding completed successfully!");
});

app.get("/reauth", (req, res) => {
  res.send("⚠️ Onboarding interrupted, please try again.");
});

// Use raw body parser for Stripe webhooks
app.post("/webhook", bodyParser.raw({ type: "application/json" }), (req, res) => {
  console.log('📩 Webhook called');
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Handle different events
  switch (event.type) {
    case "account.updated":
      const account = event.data.object;
      console.log("🔔 Account updated:", account.id);

      const ambassadorId = account.metadata?.ambassadorId;

      if (ambassadorId) {
        const ambassadorRef = doc(db, "ambassadors", ambassadorId);

        const stripeStatus = {
          connectAccountId: account.id,
          onboardingCompleted: account.details_submitted || false,
          chargesEnabled: account.charges_enabled || false,
          payoutsEnabled: account.payouts_enabled || false,
          disabledReason: account.requirements?.disabled_reason || null,
          currentlyDue: account.requirements?.currently_due || [],
          eventuallyDue: account.requirements?.eventually_due || [],
          pastDue: account.requirements?.past_due || [],
          stripeOnboardingUrl: account.stripeOnboardingUrl || null, // if available
        };

        updateDoc(ambassadorRef, { stripe: stripeStatus })
          .then(() => console.log("✅ Ambassador Stripe status updated in Firestore"))
          .catch(err => console.error("Firestore update failed:", err));
      } else {
        console.warn("⚠️ No ambassadorId metadata found on account:", account.id);
      }
      break;

    case "account.application.deauthorized":
      const deauthAccount = event.data.object;
      console.log("⚠️ Account deauthorized:", deauthAccount.id);

      const deAuthAmbassadorId = deauthAccount.metadata?.ambassadorId;
      if (deAuthAmbassadorId) {
        const ambassadorRef = doc(db, "ambassadors", deAuthAmbassadorId);

        const stripeStatus = {
          connectAccountId: deauthAccount.id,
          onboardingCompleted: false,
          chargesEnabled: false,
          payoutsEnabled: false,
          disabledReason: "application_deauthorized",
          currentlyDue: [],
          eventuallyDue: [],
          pastDue: [],
          stripeOnboardingUrl: null,
        };

        updateDoc(ambassadorRef, { stripe: stripeStatus })
          .then(() => console.log("✅ Ambassador marked as deauthorized in Firestore"))
          .catch(err => console.error("Firestore update failed:", err));
      } else {
        console.warn("⚠️ No ambassadorId metadata found on deauthorized account:", deauthAccount.id);
      }
      break;

    default:
      console.log(`ℹ️ Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});


// ------------------- Start Server -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
