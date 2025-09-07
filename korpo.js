// Firebase
import { db } from "./firebase.js";
import dotenv from 'dotenv';
import express from "express";
import { v4 as uuidv4 } from "uuid";
import Stripe from "stripe";
import bodyParser from "body-parser";
import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  query,
  where,
  doc,
  updateDoc,
  deleteDoc,
  increment,
  serverTimestamp,
  setDoc
} from "firebase/firestore";
import cors from "cors";

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
// ✅ Enable CORS for all routes & origins
app.use(cors());

// ------------------- Test Endpoint -------------------
app.get("/hello", (req, res) => {
  console.log("Stripe key:", process.env.STRIPE_SECRET_KEY);
  res.json({
    message: "Hello! The server is running with full potential 🚀",
    stripeKey: process.env.STRIPE_SECRET_KEY, // ⚠️ remove if you don’t want to expose your secret key
    webhookKey: process.env.STRIPE_WEBHOOK_SECRET
  });
});

// ------------------- Partner Endpoints -------------------

// Create Partner
app.post("/api/partner", async (req, res) => {
  try {
    const {
      businessName,
      businessType,
      contactEmail,
      contactPhone,
      description,
      discountPercentage,
      email,
      firstName,
      lastName,
      location,
      status,
      userId,
      userRange,
      website,
      agreements,
      agreementTerms,
      commission
    } = req.body;

    // ✅ Step 1: Check if user exists
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return res.status(400).json({ error: "User does not exist" });
    }

    // ✅ Step 2: Create Partner (without ID first)
    const partnerRef = doc(db, "partners", userId);
    await setDoc(partnerRef, {
      businessName,
      businessType,
      contactEmail,
      contactPhone,
      description,
      discountPercentage,
      email,
      firstName,
      lastName,
      location,
      status: status || "pending",
      userId,
      userRange,
      website,
      commission: commission || 0,
      agreements: agreements || "",
      agreementTerms: agreementTerms || false,
      createdAt: serverTimestamp(),
      lastUpdated: new Date()
    });

    res.status(201).json({
      message: "Partner created successfully (awaiting admin approval)",
    });
  } catch (error) {
    console.error("Error creating partner:", error);
    res.status(500).json({ error: "Failed to create partner" });
  }
});

/**
 * Get All Partners
 */
app.get("/api/partners", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "partners"));
    const partners = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));

    res.json(partners);
  } catch (error) {
    console.error("🔥 Error fetching partners:", error);
    res.status(500).json({ error: "Failed to fetch partners" });
  }
});

/**
 * Get Partner by ID
 */
app.get("/api/partner/:id", async (req, res) => {
  try {
    const partnerId = req.params.id;

    const docRef = doc(db, "partners", partnerId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      console.warn(`❌ Partner not found: ${partnerId}`);
      return res.status(404).json({ error: "Partner not found" });
    }

    res.json({ id: docSnap.id, ...docSnap.data() });
  } catch (error) {
    console.error("🔥 Error fetching partner:", error);
    res.status(500).json({ error: "Failed to fetch partner" });
  }
});

/**
 * Update Partner
 */
app.put("/api/partner/:id", async (req, res) => {
  try {
    const partnerId = req.params.id;
    const data = req.body;

    // Basic validations
    if (data.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail)) {
      return res.status(400).json({ error: "Valid contact email is required" });
    }
    if (data.discountPercentage !== undefined &&
      (data.discountPercentage < 0 || data.discountPercentage > 100)) {
      return res.status(400).json({ error: "Discount percentage must be between 0 and 100" });
    }

    // Validate user if userId is being updated
    if (data.userId) {
      const userRef = doc(db, "users", data.userId);
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) {
        return res.status(400).json({ error: "User does not exist" });
      }
    }

    const docRef = doc(db, "partners", partnerId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return res.status(404).json({ error: "Partner not found" });
    }

    const updatePayload = {};
    Object.keys(data).forEach((key) => {
      if (data[key] !== undefined) updatePayload[key] = data[key];
    });

    updatePayload.updatedAt = serverTimestamp();

    await updateDoc(docRef, updatePayload);
    console.log(`✅ Partner updated: ${partnerId}`);

    res.json({ message: "Partner updated successfully" });
  } catch (error) {
    console.error("🔥 Error updating partner:", error);
    res.status(500).json({ error: "Failed to update partner" });
  }
});

/**
 * Delete Partner
 */
app.delete("/api/partner/:id", async (req, res) => {
  try {
    const partnerId = req.params.id;
    const docRef = doc(db, "partners", partnerId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return res.status(404).json({ error: "Partner not found" });
    }

    await deleteDoc(docRef);
    console.log(`🗑 Partner deleted: ${partnerId}`);

    res.json({ message: "Partner deleted successfully" });
  } catch (error) {
    console.error("🔥 Error deleting partner:", error);
    res.status(500).json({ error: "Failed to delete partner" });
  }
});


// ------------verify user-----------
app.post("/api/verifyUser", async (req, res) => {
  try {
    const { userId, promoCode } = req.body;
    if (!userId || !promoCode) {
      return res.status(400).json({ error: "userId and promoCode are required" });
    }
    // :white_check_mark: 1. Check if record exists in partnerTracking
    const trackingQuery = query(
      collection(db, "partnerTracking"),
      where("userId", "==", userId),
      where("promoCode", "==", promoCode)
    );
    const trackingSnap = await getDocs(trackingQuery);
    if (!trackingSnap.empty) {
      // user already used this promo
      return res.json({ message: "code used already" });
    }
    // :white_check_mark: 2. If not used → fetch promo details
    const promoQuery = query(
      collection(db, "partnerPromoCodes"),
      where("code", "==", promoCode)
    );
    const promoSnap = await getDocs(promoQuery);
    if (promoSnap.empty) {
      return res.status(404).json({ error: "Promo code not found" });
    }
    const promoData = promoSnap.docs[0].data();
    return res.json({
      message: "code valid",
      discountPercentage: promoData.discountPercentage || 0,
    });
  } catch (error) {
    console.error(":fire: Error verifying user:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ------------------- Promo Code Endpoints -------------------

// Admin approves partner & create promo
app.post("/api/partner/:partnerId/approve", async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { code, discountPercentage, validFrom, validTo, usageLimit } = req.body;

    // ✅ Step 1: Fetch partner directly by docId
    const partnerRef = doc(db, "partners", partnerId);
    const partnerSnap = await getDoc(partnerRef);

    if (!partnerSnap.exists()) {
      return res.status(404).json({ error: "Partner not found" });
    }

    const partnerData = partnerSnap.data();
    const userId = partnerData.userId;

    // ✅ Step 2: Create promo code
    const promoData = {
      partnerId,
      code,
      discountPercentage: discountPercentage || 0,
      validFrom: validFrom || null,
      validTo: validTo || null,
      usageLimit: usageLimit || null,
      timesUsed: 0,
      createdAt: serverTimestamp(),
    };

    const promoRef = await addDoc(collection(db, "partnerPromoCodes"), promoData);

    // ✅ Step 3: Update partner document with status + promo info
    await updateDoc(partnerRef, {
      status: "approved",
      promoId: promoRef.id,
      promoCode: promoData.code,
      discountPercentage: promoData.discountPercentage,
      validTo: promoData.validTo,
    });

    // ✅ Step 4: Update related user document
    if (userId) {
      const userRef = doc(db, "users", userId);
      await updateDoc(userRef, {
        isPartner: true,
        "partnerApplication.status": "approved"
      });

    }

    res.status(201).json({
      message: "Partner approved, promo created & user updated",
      promo: { firestoreId: promoRef.id, ...promoData },
    });

  } catch (error) {
    console.error("🔥 Error approving partner + promo:", error);
    res.status(500).json({ error: error.message }); // ✅ Show actual error message
  }
});

// Get All Promo Codes
app.get("/api/promoCodes", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "partnerPromoCodes"));
    const promoCodes = snapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    res.json(promoCodes);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch promo codes" });
  }
});

// Validate Promo Code
app.get("/api/promoCode/validate/:code", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "partnerPromoCodes"));
    const promo = snapshot.docs
      .map(docSnap => ({ firestoreId: docSnap.id, ...docSnap.data() }))
      .find(p => p.code === req.params.code);

    if (!promo) return res.status(404).json({ valid: false, error: "Promo not found" });

    const now = new Date();
    if (now < new Date(promo.validFrom) || now > new Date(promo.validTo)) {
      return res.status(400).json({ valid: false, error: "Promo expired" });
    }

    if (promo.timesUsed >= promo.usageLimit) {
      return res.status(400).json({ valid: false, error: "Usage limit reached" });
    }

    res.json({ valid: true, discount: promo.discountPercentage, promo });
  } catch (error) {
    res.status(500).json({ error: "Failed to validate promo code" });
  }
});

// Delete Promo Code
app.delete("/api/promoCode/:id", async (req, res) => {
  try {
    const promoRef = doc(db, "partnerPromoCodes", req.params.id);
    await deleteDoc(promoRef);
    res.json({ message: "Promo code deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete promo code" });
  }
});

// Use Promo Code
app.post("/api/promoCode/use/:code", async (req, res) => {
  try {
    const { userId, amount } = req.body; // 📝 get userId & amount

    if (!userId || amount === undefined) {
      return res.status(400).json({ error: "userId and amount are required" });
    }

    // ✅ 1. Check if user exists
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    // ✅ 2. Find promo code
    const promoQuery = query(
      collection(db, "partnerPromoCodes"),
      where("code", "==", req.params.code)
    );

    const snapshot = await getDocs(promoQuery);
    if (snapshot.empty) {
      return res.status(404).json({ error: "Promo code not found" });
    }

    const promoDoc = snapshot.docs[0];
    const promoRef = promoDoc.ref;
    const promoData = promoDoc.data();

    // ✅ 3. Check usage limit
    if (
      promoData.usageLimit !== null &&
      promoData.usageLimit !== undefined &&
      promoData.timesUsed >= promoData.usageLimit
    ) {
      return res.status(400).json({ error: "Usage limit exceeded" });
    }

    // ✅ 4. Calculate discount
    const discountPercentage = promoData.discountPercentage || 0;
    const discountAmount = (amount * discountPercentage) / 100;
    const finalAmount = amount - discountAmount;

    // ✅ 5. Revenue Sharing
    let partnerSharePercentage = 30; // fallback
    const partnerId = promoData.partnerId || null;

    if (partnerId) {
      // 🔥 Direct lookup instead of query
      const partnerRef = doc(db, "partners", partnerId);
      const partnerSnap = await getDoc(partnerRef);

      if (partnerSnap.exists()) {
        const partnerData = partnerSnap.data();
        if (partnerData.commission !== undefined) {
          partnerSharePercentage = Number(partnerData.commission);
        }
      }
    }

    const partnerRevenue = (finalAmount * partnerSharePercentage) / 100;
    const companyRevenue = finalAmount - partnerRevenue;

    // ✅ 6. Increment times_used in promo
    await updateDoc(promoRef, { timesUsed: increment(1) });

    // ✅ 7. Save usage tracking
    await addDoc(collection(db, "partnerTracking"), {
      userId,
      promoCode: req.params.code,
      promoId: promoDoc.id,
      partnerId: partnerId || null,
      usedAt: new Date(),
      originalAmount: amount,
      discountPercentage,
      discountAmount,
      finalAmount,
      companyRevenue,
      partnerRevenue,
      partnerSharePercentage,
    });

    // ✅ 9. Update partner document directly (no query needed)
    if (partnerId) {
      const partnerRef = doc(db, "partners", partnerId);
      const partnerSnap = await getDoc(partnerRef);

      if (partnerSnap.exists()) {
        const timesUsed = (promoData.timesUsed || 0) + 1;
        const usageLimit = promoData.usageLimit || 0;
        const leftPromo = usageLimit > 0 ? usageLimit - timesUsed : null;

        await updateDoc(partnerRef, {
          lastUpdated: new Date(),
          totalPartnerRevenue: increment(partnerRevenue),
          timesUsed,
          leftPromo,
          totalPromo: usageLimit > 0 ? usageLimit : null,
        });
      }
    }

    // ✅ 10. Send Response
    res.json({
      message: `Promo ${req.params.code} used successfully ✅`,
      usageLimit: promoData.usageLimit,
      partnerId: partnerId,
      discountPercentage,
      discountAmount,
      finalAmount,
      companyRevenue,
      partnerRevenue,
    });
  } catch (error) {
    console.error("🔥 Error updating promo usage:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/types", async (req, res) => {
  try {
    const typeData = {
      id: uuidv4(),
      ...req.body,
      createdAt: serverTimestamp(),
    };

    const docRef = await addDoc(collection(db, "types"), typeData);
    res.status(201).json({ firestoreId: docRef.id, ...typeData });
  } catch (error) {
    console.error("Error creating type:", error);
    res.status(500).json({ error: "Failed to create type" });
  }
});

// Get All Types
app.get("/api/types", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "types"));
    const types = snapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    res.json(types);
  } catch (error) {
    console.error("Error fetching types:", error);
    res.status(500).json({ error: "Failed to fetch types" });
  }
});


// -----------partner stats---------------------------

// ✅ Get overall Stats for a partner
app.get("/api/revenue/:partnerId", async (req, res) => {
  try {
    const { partnerId } = req.params;

    if (!partnerId) {
      return res.status(400).json({ error: "partnerId is required" });
    }

    // ✅ Fetch all tracking entries for this partner
    const trackingQuery = query(
      collection(db, "partnerTracking"),
      where("partnerId", "==", partnerId)
    );

    const trackingSnap = await getDocs(trackingQuery);

    // ✅ Initialize revenue variables (will stay 0 if no records exist)
    let totalRevenue = 0;
    let korpoNetRevenue = 0;
    let partnerRevenue = 0;
    let totalDiscountGiven = 0;
    const userSet = new Set();

    if (!trackingSnap.empty) {
      trackingSnap.forEach((doc) => {
        const data = doc.data();

        totalRevenue += data.finalAmount || 0;
        korpoNetRevenue += data.companyRevenue || 0;
        partnerRevenue += data.partnerRevenue || 0;
        totalDiscountGiven += data.discountAmount || 0;

        if (data.userId) userSet.add(data.userId);
      });
    }

    const totalMembers = userSet.size;

    // ✅ Fetch latest promo code details for this partner
    const promoQuery = query(
      collection(db, "partnerPromoCodes"),
      where("partnerId", "==", partnerId)
    );
    const promoSnap = await getDocs(promoQuery);

    let promoDetails = {};
    if (!promoSnap.empty) {
      const promos = promoSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

      const latestPromo = promos[0];
      const usageLimit = latestPromo.usageLimit || 0;
      const timesUsed = latestPromo.timesUsed || 0;
      const leftPromo = usageLimit > 0 ? usageLimit - timesUsed : null;

      promoDetails = {
        promoId: latestPromo.id,
        promoCode: latestPromo.code || null,
        usageLimit,
        timesUsed,
        leftPromo,
        validTo: latestPromo.validTo || null,
      };
    }

    // ✅ Always return a response, even with no tracking records
    res.json({
      partnerId,
      totalRevenue,
      korpoNetRevenue,
      partnerRevenue,
      totalDiscountGiven,
      totalMembers,
      ...promoDetails,
    });
  } catch (error) {
    console.error("🔥 Error fetching partner revenue:", error.message);
    res.status(500).json({ error: error.message });
  }
});


// :white_check_mark: Monthly Status API
app.get("/api/partner/monthlyStats/:partnerId", async (req, res) => {
  try {
    const { partnerId } = req.params;
    if (!partnerId) {
      return res.status(400).json({ error: "partnerId is required" });
    }

    // 1️⃣ Fetch all promo codes for this partner
    const promoQuery = query(
      collection(db, "partnerPromoCodes"),
      where("partnerId", "==", partnerId)
    );
    const promoSnap = await getDocs(promoQuery);

    let totalPromoCodes = promoSnap.size;
    let leftPromoCodes = 0;
    promoSnap.forEach((doc) => {
      const data = doc.data();
      if (data.usageLimit !== undefined && data.timesUsed !== undefined) {
        leftPromoCodes += Math.max(data.usageLimit - data.timesUsed, 0);
      }
    });

    // 2️⃣ Fetch all tracking entries for this partner
    const trackingQuery = query(
      collection(db, "partnerTracking"),
      where("partnerId", "==", partnerId)
    );
    const trackingSnap = await getDocs(trackingQuery);

    // ✅ Monthly aggregations
    let monthlyTotalFinalAmount = 0;
    let monthlyTotalCompanyRevenue = 0;
    let monthlyTotalPartnerRevenue = 0;
    let monthlyTotalDiscountGiven = 0;

    const userSet = new Set();

    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    trackingSnap.forEach((doc) => {
      const data = doc.data();
      const usedAt = data.usedAt?.toDate ? data.usedAt.toDate() : new Date(data.usedAt);

      if (usedAt >= firstDayOfMonth && usedAt <= lastDayOfMonth) {
        monthlyTotalFinalAmount += data.finalAmount || 0;
        monthlyTotalCompanyRevenue += data.companyRevenue || 0;
        monthlyTotalPartnerRevenue += data.partnerRevenue || 0;
        monthlyTotalDiscountGiven += data.discountAmount || 0;

        if (data.userId) {
          userSet.add(data.userId);
        }
      }
    });

    const monthlyNewMembers = userSet.size;

    // 3️⃣ Get latest promo code details (like revenue API)
    let promoDetails = {};
    if (!promoSnap.empty) {
      const promos = promoSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

      const latestPromo = promos[0];

      const usageLimit = latestPromo.usageLimit || 0;
      const timesUsed = latestPromo.timesUsed || 0;
      const leftPromo = usageLimit > 0 ? usageLimit - timesUsed : null;

      promoDetails = {
        promoId: latestPromo.id,
        promoCode: latestPromo.code || null,
        usageLimit,
        timesUsed,
        leftPromo,
        validTo: latestPromo.validTo || null,
      };
    }

    // ✅ Format month like "March 2025"
    const monthFormatted = now.toLocaleString("en-US", { month: "long", year: "numeric" });

    // 4️⃣ Response
    res.json({
      partnerId,
      totalPromoCodes,
      leftPromoCodes,
      monthlyTotalRevenue: monthlyTotalFinalAmount,
      monthlyKorpoNetRevenue: monthlyTotalCompanyRevenue,
      monthlyPartnerRevenue: monthlyTotalPartnerRevenue,
      monthlyTotalDiscountGiven: monthlyTotalDiscountGiven,
      monthlyNewMembers,
      month: monthFormatted, // ✅ Now shows "March 2025"
      ...promoDetails,
    });

  } catch (error) {
    console.error("🔥 Error fetching monthly status:", error.message);
    res.status(500).json({ error: error.message });
  }
});


// -------------------------STRIPE CONNECT ROUTES-------------------------

// ------------------- 1️⃣ Create Connected Account -------------------
app.post("/api/createConnectId", async (req, res) => {
  console.log("📩 [Backend] /create-connectId called with body:", req.body);

  const { userId, email, role } = req.body;

  if (!userId || !email || !role) {
    console.log("❌ Missing userId, email, or role");
    return res.status(400).json({ error: "userId, email, and role are required" });
  }

  // ✅ Determine which Firestore collection to use
  const validRoles = ["ambassador", "partner"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
  }

  try {
    const collectionName = role === "partner" ? "partners" : "ambassadors";
    const userRef = doc(db, collectionName, userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      console.log(`❌ ${role} not found in Firestore:`, userId);
      return res.status(404).json({ error: `${role} not found` });
    }

    // ✅ Create Stripe Connect account
    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      email,
      capabilities: { transfers: { requested: true } },
      metadata: { userId, role },
    });

    console.log(`✅ Stripe account created for ${role}:`, account);

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

    // ✅ Update Firestore document
    await updateDoc(userRef, { stripe: stripeData });

    console.log(`✅ Firestore updated for ${role}:`, userId);

    res.json({
      message: "Connect account created successfully",
      connectAccountId: account.id,
      role,
    });

  } catch (err) {
    console.error("🔥 Error in /create-connectId:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------- 2️⃣ Generate Onboarding Link -------------------
app.post("/api/onboardingLink", async (req, res) => {
  console.log("📩 [Backend] /onboarding-link called with body:", req.body);

  const { userId, connectAccountId, role } = req.body;

  if (!userId || !connectAccountId || !role) {
    return res.status(400).json({ error: "userId, connectAccountId, and role are required" });
  }

  // ✅ Determine collection dynamically
  const validRoles = ["ambassador", "partner"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
  }

  try {
    // ✅ Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: connectAccountId,
      refresh_url: "https://stripe-production-af7d.up.railway.app/reauth",  // ✅ Replace in production
      return_url: "https://stripe-production-af7d.up.railway.app/success",  // ✅ Replace in production
      type: "account_onboarding",
    });

    // ✅ Fetch latest account details from Stripe
    const account = await stripe.accounts.retrieve(connectAccountId);
    console.log(`✅ Stripe account fetched for ${role}:`, account.id);

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
    const collectionName = role === "partner" ? "partners" : "ambassadors";
    const userRef = doc(db, collectionName, userId);
    await updateDoc(userRef, { stripe: stripeData });

    console.log(`✅ Firestore updated with onboarding link for ${role}:`, userId);

    res.json({
      message: "Onboarding link generated",
      onboardingUrl: accountLink.url,
      role,
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

app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
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
      {
        const account = event.data.object;
        console.log("🔔 Account updated:", account.id);

        const userId = account.metadata?.userId;
        const role = account.metadata?.role; // ambassador or partner

        if (!userId || !role) {
          console.warn("⚠️ No userId or role metadata found on account:", account.id);
          break;
        }

        const collectionName = role === "partner" ? "partners" : "ambassadors";
        const userRef = doc(db, collectionName, userId);

        const stripeStatus = {
          connectAccountId: account.id,
          onboardingCompleted: account.details_submitted || false,
          chargesEnabled: account.charges_enabled || false,
          payoutsEnabled: account.payouts_enabled || false,
          disabledReason: account.requirements?.disabled_reason || null,
          currentlyDue: account.requirements?.currently_due || [],
          eventuallyDue: account.requirements?.eventually_due || [],
          pastDue: account.requirements?.past_due || [],
          stripeOnboardingUrl: account.stripeOnboardingUrl || null,
        };

        updateDoc(userRef, { stripe: stripeStatus })
          .then(() => console.log(`✅ ${role} Stripe status updated in Firestore`))
          .catch(err => console.error("Firestore update failed:", err));
      }
      break;

    case "account.application.deauthorized":
      {
        const deauthAccount = event.data.object;
        console.log("⚠️ Account deauthorized:", deauthAccount.id);

        const userId = deauthAccount.metadata?.userId;
        const role = deauthAccount.metadata?.role;

        if (!userId || !role) {
          console.warn("⚠️ No userId or role metadata found on deauthorized account:", deauthAccount.id);
          break;
        }

        const collectionName = role === "partner" ? "partners" : "ambassadors";
        const userRef = doc(db, collectionName, userId);

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

        updateDoc(userRef, { stripe: stripeStatus })
          .then(() => console.log(`✅ ${role} marked as deauthorized in Firestore`))
          .catch(err => console.error("Firestore update failed:", err));
      }
      break;

    default:
      console.log(`ℹ️ Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

app.post("/api/requestPayoutForAmbassador", async (req, res) => {
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
    const payoutRef = collection(db, "ambassadorPayouts"); // or subcollection under ambassador
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

app.post("/api/approvePayoutForAmbassador", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "requestId is required" });
  }

  try {
    // 1️⃣ Fetch payout request
    const requestRef = doc(db, "ambassadorPayouts", requestId);
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

app.post("/api/cancelPayoutForAmbassador", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "requestId is required" });
  }

  try {
    // 1️⃣ Fetch payout request
    const requestRef = doc(db, "ambassadorPayouts", requestId);
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

app.post("/api/requestPayoutForPartner", async (req, res) => {
  const { partnerId, connectedAccountId } = req.body;

  if (!partnerId || !connectedAccountId) {
    return res.status(400).json({ error: "partnerId and connectedAccountId are required" });
  }

  try {
    // 1️⃣ Fetch partner from Firestore
    const partnerRef = doc(db, "partners", partnerId);
    const partnerSnap = await getDoc(partnerRef);

    if (!partnerSnap.exists()) {
      return res.status(404).json({ error: "Partner not found" });
    }

    const partner = partnerSnap.data();

    // 2️⃣ Validate account ID and balance
    if (partner?.stripe?.connectAccountId !== connectedAccountId) {
      return res.status(400).json({ error: "Connected account ID mismatch" });
    }

    const balance = partner?.commissionEarned || 0; // Adjust field name if different
    if (balance <= 0) {
      return res.status(400).json({ error: "No referral balance available" });
    }

    // 3️⃣ Create payout request in Firestore
    const payoutRef = collection(db, "partnerPayouts"); // Or subcollection under partner
    const newRequest = await addDoc(payoutRef, {
      partnerId,
      connectedAccountId,
      amount: balance,
      status: "pending",
      createdAt: serverTimestamp(),
    });

    // 4️⃣ Respond
    res.json({
      message: "Payout request submitted",
      requestId: newRequest.id,
      amount: balance,
    });

  } catch (err) {
    console.error("🔥 Error in /requestPayoutForPartner:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/approvePayoutForPartner", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "requestId is required" });
  }

  try {
    // 1️⃣ Fetch payout request
    const requestRef = doc(db, "partnerPayouts", requestId);
    const requestSnap = await getDoc(requestRef);

    if (!requestSnap.exists()) {
      return res.status(404).json({ error: "Request not found" });
    }

    const request = requestSnap.data();

    if (request.status !== "pending") {
      return res.status(400).json({ error: "Request already processed" });
    }

    // 2️⃣ Fetch partner
    const partnerRef = doc(db, "partners", request.partnerId);
    const partnerSnap = await getDoc(partnerRef);

    if (!partnerSnap.exists()) {
      return res.status(404).json({ error: "Partner not found" });
    }

    const partner = partnerSnap.data();

    // 3️⃣ Calculate payout (10% of referral_balance)
    const payoutAmount = partner.commissionEarned * 0.10; // Adjust field if necessary
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

    // 6️⃣ Prepare response
    const formattedAmount = payoutAmount.toFixed(2);
    const partnerName = partner.name || "Partner";

    res.json({
      status: "success",
      message: `🎉 Congratulations ${partnerName}! You’ve been paid $${formattedAmount}.`,
      amount: formattedAmount,
    });

  } catch (err) {
    console.error("🔥 Error approving partner payout:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/cancelPayoutForPartner", async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "requestId is required" });
  }

  try {
    // 1️⃣ Fetch payout request
    const requestRef = doc(db, "partnerPayouts", requestId);
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
    console.error("🔥 Error cancelling partner payout:", err);
    res.status(500).json({ error: err.message });
  }
});




// ------------------- Start Server -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
