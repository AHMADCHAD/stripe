import express from "express";
import Stripe from "stripe";
import bodyParser from "body-parser";
// Firebase
import { db } from "./firebase.js";
import { doc, getDoc, updateDoc, collection, addDoc, serverTimestamp } from "firebase/firestore";
import dotenv from 'dotenv';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // ✅ Read from env

const app = express();
// 👇 Put JSON parser BEFORE routes, but exclude /webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// ------------------- Test Endpoint -------------------
app.get("/hello", (req, res) => {
  console.log("Stripe key:", process.env.STRIPE_SECRET_KEY);
  res.json({
    message: "Hello! The server is running with full potential 🚀",
    stripeKey: process.env.STRIPE_SECRET_KEY, // ⚠️ remove if you don’t want to expose your secret key
    webhookKey: process.env.STRIPE_WEBHOOK_SECRET
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

app.post("/request-payout", async (req, res) => {
  const { ambassadorId, connectedAccountId } = req.body;

  if (!ambassadorId || !connectedAccountId) {
    return res.status(400).json({ error: "ambassadorId and connectedAccountId are required" });
  }

  try {
    // 1️⃣ Fetch ambassador from Firestore
    const ambassadorRef = doc(db, "ambassadors", ambassadorId);
    const ambassadorSnap = await getDoc(ambassadorRef);

    if (!ambassadorSnap.exists()) {
      return res.status(404).json({ error: "Ambassador not found" });
    }

    const ambassador = ambassadorSnap.data();

    // 2️⃣ Validate account ID and balance
    if (ambassador?.stripe?.connectAccountId !== connectedAccountId) {
      return res.status(400).json({ error: "Connected account ID mismatch" });
    }

    const balance = ambassador?.commissionEarned || 0;
    if (balance <= 0) {
      return res.status(400).json({ error: "No referral balance available" });
    }

    // 3️⃣ Create payout request in Firestore (Firestore auto-generates ID)
    const payoutRef = collection(db, "ambassador_payouts"); // or subcollection under ambassador
    const newRequest = await addDoc(payoutRef, {
      ambassadorId,
      connectedAccountId,
      amount: balance,
      status: "pending", // can later update to "approved", "paid", etc.
      createdAt: serverTimestamp(),
    });

    // 4️⃣ Respond
    res.json({
      message: "Payout request submitted",
      requestId: newRequest.id, // Firestore’s auto ID
      amount: balance,
    });

  } catch (err) {
    console.error("🔥 Error in /request-payout:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/approve-payout", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "requestId is required" });
  }

  try {
    // 1️⃣ Fetch payout request
    const requestRef = doc(db, "ambassador_payouts", requestId);
    const requestSnap = await getDoc(requestRef);

    if (!requestSnap.exists()) {
      return res.status(404).json({ error: "Request not found" });
    }

    const request = requestSnap.data();

    if (request.status !== "pending") {
      return res.status(400).json({ error: "Request already processed" });
    }

    // 2️⃣ Fetch ambassador
    const ambassadorRef = doc(db, "ambassadors", request.ambassadorId);
    const ambassadorSnap = await getDoc(ambassadorRef);

    if (!ambassadorSnap.exists()) {
      return res.status(404).json({ error: "Ambassador not found" });
    }

    const ambassador = ambassadorSnap.data();

    // 3️⃣ Calculate payout (10% of referral_balance)
    const payoutAmount = ambassador.commissionEarned * 0.10;
    if (payoutAmount <= 0) {
      return res.status(400).json({ error: "No balance available for payout" });
    }

    const amountInCents = Math.round(payoutAmount * 100);

    // 4️⃣ Send payment via Stripe
    const transfer = await stripe.transfers.create({
      amount: amountInCents,
      currency: "usd",
      destination: request.connectedAccountId,
    });

    // 5️⃣ Update payout request
    await updateDoc(requestRef, {
      status: "approved",
      approvedAt: serverTimestamp(),
      transferId: transfer.id,
    });

    // 6️⃣ Prepare nice response
    const formattedAmount = payoutAmount.toFixed(2); // e.g. 14.00
    const ambassadorName = `${ambassador.firstName || ""} ${ambassador.lastName || ""}`.trim();

    res.json({
      status: "success",
      message: `🎉 Congratulations ${ambassadorName || "Ambassador"}! You’ve been paid $${formattedAmount}.`,
      amount: formattedAmount,
    });


  } catch (err) {
    console.error("🔥 Error approving payout:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/cancel-payout", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "requestId is required" });
  }

  try {
    // 1️⃣ Fetch payout request
    const requestRef = doc(db, "payout_requests", requestId);
    const requestSnap = await getDoc(requestRef);

    if (!requestSnap.exists()) {
      return res.status(404).json({ error: "Request not found" });
    }

    const request = requestSnap.data();

    // 2️⃣ Ensure request is still pending
    if (request.status !== "pending") {
      return res.status(400).json({ error: "Request already processed" });
    }

    // 3️⃣ Mark as cancelled
    await updateDoc(requestRef, {
      status: "cancelled",
      cancelledAt: serverTimestamp(),
    });

    // 4️⃣ Respond
    res.json({ message: "Payout request cancelled" });

  } catch (err) {
    console.error("🔥 Error cancelling payout:", err);
    res.status(500).json({ error: err.message });
  }
});


// ------------------- Start Server -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
