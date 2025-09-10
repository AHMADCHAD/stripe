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
import cron from "node-cron";
import nodemailer from "nodemailer";

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

// Setup transporter (for Gmail SMTP, or use SendGrid API instead)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, // your@gmail.com
    pass: process.env.EMAIL_PASS, // app password
  },
});


// Runs every 1 minute
cron.schedule("0 0 25 * *", async () => {
  console.log("🚀 Sending monthly reminder (25th day)...");

  const usersSnap = await getDocs(collection(db, "users"));

  usersSnap.forEach(async (docSnap) => {
    const user = docSnap.data();
    if (user.email) {
      await transporter.sendMail({
        from: `"Korpo" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: "Your Monthly Reminder",
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #4CAF50;">Hello ${user.name || "there"},</h2>
            <p>
              This is your friendly monthly reminder from <b>Korpo</b>.  
              We value your time and want to ensure you never miss important updates.
            </p>
            <p>
              🔔 <b>Reminder:</b> Please take a moment to review your account and stay up to date.
            </p>
            <p style="margin-top: 20px;">Best regards,</p>
            <p><b>Your Company Team</b></p>
            <hr>
            <small style="color: #777;">This is an automated message. Please do not reply.</small>
          </div>
        `,
      });
      console.log(`✅ Sent email to: ${user.email}`);
    }
  });
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

// ------------------- Partner Endpoints -------------------
// Create Partner
app.post("/api/partner/submitApplication", async (req, res) => {
  try {
    const {
      businessName,
      businessType,
      contactEmail,
      contactPhone,
      description,
      discountRate, // comes as 30
      email,
      firstName,
      lastName,
      location,
      status,
      userId,
      userRange,
      promoCode,
      website,
      agreements,
      agreementTerms,
      commissionRate // comes as 10
    } = req.body;

    // ✅ Step 1: Check if user exists
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      return res.status(400).json({ error: "User does not exist" });
    }

    // ✅ Step 2: Generate unique promo code
    let finalCode = promoCode || "";
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 5) {
      if (!finalCode) finalCode = `PRM${userId.slice(-4).toUpperCase()}${Math.floor(Math.random() * 1000)}`;

      const q = query(collection(db, "promoCodes"), where("promoCode", "==", finalCode));
      const existing = await getDocs(q);

      if (existing.empty) {
        isUnique = true;
      } else {
        finalCode = ""; // regenerate
      }

      attempts++;
    }

    if (!isUnique) {
      return res.status(400).json({ error: "Failed to generate unique promo code. Try again." });
    }


    // ✅ Step 2.5: Convert commission/discount to decimal
    const commissionDecimal = commissionRate ? commissionRate / 100 : 0; // e.g. 10 → 0.1
    const discountDecimal = discountRate ? discountRate / 100 : 0; // e.g. 30 → 0.3

    // ✅ Step 3: Create promo code record
    const promoData = {
      partnerId: userId,
      promoCode: finalCode,
      validFrom: null,
      validTo: null,
      discountRate: discountDecimal,
      usageLimit: 100,
      status: "pending", // pending until partner approved
      timesUsed: 0,
      createdAt: serverTimestamp(),
    };
    const promoRef = await addDoc(collection(db, "promoCodes"), promoData);

    // ✅ Step 4: Create Partner document
    const partnerRef = doc(db, "partners", userId);
    await setDoc(partnerRef, {
      businessName,
      businessType,
      contactEmail,
      contactPhone,
      promoCode: finalCode,
      promoId: promoRef.id,
      description,
      discountRate: discountDecimal,   // ✅ consistent naming
      email,
      firstName,
      lastName,
      location,
      status: status || "pending",
      userId,
      userRange,
      website,
      totalPartnerRevenue: 0,
      commissionRate: commissionDecimal, // ✅ stored as decimal
      totalPromos: 0,
      availableBalance: 0,
      agreements: agreements || "",
      agreementTerms: agreementTerms || false,
      createdAt: serverTimestamp(),
      lastUpdated: new Date()
    });

    // ✅ Step 5: Update user document with partnerApplication info
    await updateDoc(userRef, {
      partnerApplication: {
        status: status || "pending",
        createdAt: new Date(),
        partnerId: userId,
      },
      hasAppliedForPartner: true,
    });

    res.status(201).json({
      message: "Partner created successfully (awaiting admin approval)",
    });
  } catch (error) {
    console.error("🔥 Error creating partner:", error);
    res.status(500).json({ error: "Failed to create partner" });
  }
});

app.post("/api/partner/:partnerId/updateStatus", async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { newStatus } = req.body;

    if (!newStatus) {
      return res.status(400).json({ error: "Missing newStatus" });
    }

    // 1️⃣ Fetch partner
    const partnerRef = doc(db, "partners", partnerId);
    const partnerSnap = await getDoc(partnerRef);

    if (!partnerSnap.exists()) {
      return res.status(404).json({ error: "Partner not found" });
    }

    const partnerData = partnerSnap.data();
    const userId = partnerData.userId;
    const promoCode = partnerData.promoCode;

    let promoData = null;

    // 2️⃣ Handle approved
    if (newStatus === "approved" && promoCode) {
      const validFrom = new Date();
      const validTo = new Date(validFrom);
      validTo.setDate(validTo.getDate() + 100);

      // Update promoCode doc
      if (partnerData.promoId) {
        const promoRef = doc(db, "promoCodes", partnerData.promoId);
        const promoSnap = await getDoc(promoRef);

        if (promoSnap.exists()) {
          const existingPromo = promoSnap.data();

          promoData = {
            code: partnerData.promoCode,
            status: "active",
            updatedAt: new Date(),
          };

          // ✅ Only set validFrom/validTo if they don’t already exist
          if (!existingPromo.validFrom) {
            promoData.validFrom = validFrom;
          }
          if (!existingPromo.validTo) {
            promoData.validTo = validTo;
          }

          await updateDoc(promoRef, promoData);
        }
      }

      // Update partner doc (always update status + expiry info)
      await updateDoc(partnerRef, {
        status: "approved",
        promoCode,
        promoCodeValidTo: validTo,
        updatedAt: new Date(),
      });
    }
    else if (newStatus === "declined") {
      const promoRef = doc(db, "promoCodes", partnerData.promoId);
      await updateDoc(partnerRef, {
        status: "declined",
        updatedAt: new Date(),
      });
      await updateDoc(promoRef, {
        status: "inactive",
        updatedAt: new Date(),
      });


    } else {
      await updateDoc(partnerRef, {
        status: newStatus,
        updatedAt: new Date(),
      });
    }

    // 3️⃣ Update related user doc
    let userEmail = null;
    if (userId) {
      const userRef = doc(db, "users", userId);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const userData = userSnap.data();
        userEmail = userData.email;
        const existingApplication = userData.partnerApplication || {};
        await updateDoc(userRef, {
          isPartner: newStatus === "approved",
          partnerApplication: {
            ...existingApplication,   // ✅ Keep createdAt & partnerId intact
            status: newStatus,
            updatedAt: new Date(),
          }
        });
      }
    }

    // 4️⃣ Send email
    if (userEmail) {
      if (newStatus === "approved" && promoData) {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: userEmail,
          subject: "🎉 Partner Application Approved",
          html: `
            <h2>Congratulations!</h2>
            <p>Dear ${partnerData.firstName || "Partner"},</p>
            <p>Your partner application has been <strong>approved</strong> ✅</p>
            <p>Here are your promo details:</p>
            <ul>
              <li><strong>Promo Code:</strong> ${promoData.code}</li>
              <li><strong>Discount:</strong> ${promoData.discountRate * 100}%</li>
              <li><strong>Valid Until:</strong> ${promoData.validTo}</li>
            </ul>
          `,
        });
      } else if (newStatus === "declined") {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: userEmail,
          subject: "Partner Application Declined",
          html: `
            <h2>Application Declined</h2>
            <p>Dear ${partnerData.firstName || "Partner"},</p>
            <p>Your partner application has been <strong>declined</strong> ❌</p>
          `,
        });
      }
    }

    // 5️⃣ Respond
    res.status(200).json({
      success: true,
      message:
        newStatus === "approved"
          ? "✅ Partner approved, promo updated, user updated & email sent"
          : newStatus === "declined"
            ? "❌ Partner declined, user updated & email sent"
            : `ℹ️ Partner status updated to ${newStatus}`,
      promo: promoData || null,
    });
  } catch (error) {
    console.error("🔥 Error updating partner application:", error);
    res.status(500).json({ error: error.message });
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

// ✅ Verify Promo Code for a User
app.get("/api/promocode/:userId/verify/:promoCode", async (req, res) => {
  try {
    const { userId, promoCode } = req.params;

    if (!userId || !promoCode) {
      return res.status(400).json({ error: "userId and promoCode are required" });
    }

    // 1️⃣ Check if record exists in partnerTracking (already used)
    const trackingQuery = query(
      collection(db, "partnerTracking"),
      where("userId", "==", userId),
      where("promoCode", "==", promoCode)
    );
    const trackingSnap = await getDocs(trackingQuery);

    if (!trackingSnap.empty) {
      return res.json({ message: "Promo code already used by this user" });
    }

    // 2️⃣ Fetch promo details
    const promoQuery = query(
      collection(db, "promoCodes"),
      where("code", "==", promoCode)
    );
    const promoSnap = await getDocs(promoQuery);

    if (promoSnap.empty) {
      return res.status(404).json({ error: "Promo code not found" });
    }

    const promoData = promoSnap.docs[0].data();

    // 3️⃣ Check promo status
    if (promoData.status === "inactive") {
      return res.json({ message: "Promo code is inactive" });
    } else if (promoData.status === "pending") {
      return res.json({ message: "Promo code is pending approval" });
    } else if (promoData.status !== "active") {
      return res.json({ message: `Promo code is ${promoData.status}` });
    }

    // 4️⃣ If active → valid
    return res.json({
      message: "Promo code is valid",
      discountRate: promoData.discountRate || 0,
    });
  } catch (error) {
    console.error("🔥 Error verifying user promo:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ------------------- Promo Code Endpoints -------------------


// ✅ User purchases a plan -> only pass userId (static plan)
app.post("/api/user/:userId/purchase", async (req, res) => {
  try {
    const { userId } = req.params;

    // ✅ Step 1: Get user details
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const userData = userSnap.data();
    const userEmail = userData.email;

    // ✅ Step 2: Static plan info
    const planName = "Basic Plan";
    const planPrice = 10; // USD
    const planDuration = 30; // days

    // ✅ Step 3: Send purchase confirmation email
    if (userEmail) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: userEmail,
        subject: "✅ Plan Purchase Confirmation",
        html: `
          <h2>Thank you for your purchase 🎉</h2>
          <p>Dear ${userData.name || "User"},</p>
          <p>You have successfully purchased the following plan:</p>
          <ul>
            <li><strong>Plan:</strong> ${planName}</li>
            <li><strong>Price:</strong> $${planPrice}</li>
            <li><strong>Duration:</strong> ${planDuration} days</li>
          </ul>
          <p>Your plan is now active. Enjoy the benefits 🚀</p>
        `,
      });

      console.log(`📧 Purchase confirmation email sent to: ${userEmail}`);
    }

    res.status(200).json({
      message: "Plan purchased successfully & email sent",
      plan: { planName, planPrice, planDuration }
    });
  } catch (error) {
    console.error("🔥 Error in plan purchase:", error);
    res.status(500).json({ error: "Failed to process purchase" });
  }
});

app.post("/api/user/:userId/trial-reminder", async (req, res) => {
  try {
    const { userId } = req.params;

    // ✅ Step 1: Get user details
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const userData = userSnap.data();
    const userEmail = userData.email;

    // ✅ Step 2: Static trial info
    const trialDays = 5; // static trial length
    const currentTrialDay = 4; // ⚡ static check for demo (replace with logic later)

    // ✅ Step 3: If trial day = 4, send reminder email
    if (currentTrialDay === 4 && userEmail) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: userEmail,
        subject: "⚠️ Your Trial is Ending Soon",
        html: `
          <h2>Reminder: Trial Ending Soon</h2>
          <p>Dear ${userData.name || "User"},</p>
          <p>Your free trial will expire in <strong>1 day</strong>.</p>
          <p>Please purchase your account to continue enjoying our services.</p>
          <p><strong>Trial Days:</strong> ${currentTrialDay}/${trialDays}</p>
          <p><a href="https://yourwebsite.com/pricing">👉 Upgrade Now</a></p>
        `,
      });

      console.log(`📧 Trial reminder email sent to: ${userEmail}`);
    }

    res.status(200).json({
      message: "Trial reminder checked",
      trial: { currentTrialDay, trialDays },
    });
  } catch (error) {
    console.error("🔥 Error in trial reminder:", error);
    res.status(500).json({ error: "Failed to process trial reminder" });
  }
});


// Get All Promo Codes
app.get("/api/promoCodes", async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, "promoCodes"));
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
    const snapshot = await getDocs(collection(db, "promoCodes"));
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
    const promoRef = doc(db, "promoCodes", req.params.id);
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
      collection(db, "promoCodes"),
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
    const discountPercentage = promoData.discountRate || 0;
    const discountAmount = amount * discountPercentage
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
        if (partnerData.commissionRate !== undefined) {
          partnerSharePercentage = Number(partnerData.commissionRate);
        }
      }
    }

    const partnerRevenue = finalAmount * partnerSharePercentage;
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
          availableBalance: increment(partnerRevenue),
          totalDiscountGiven: increment(discountAmount),
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
// /api/partner / stats /: partnerId
// ✅ Get overall Stats for a partner
app.get("/api/partner/stats/:partnerId", async (req, res) => {
  try {
    const { partnerId } = req.params;

    if (!partnerId) {
      return res.status(400).json({ error: "partnerId is required" });
    }

    // 1️⃣ Fetch all tracking entries for this partner
    const trackingQuery = query(
      collection(db, "partnerTracking"),
      where("partnerId", "==", partnerId)
    );

    const trackingSnap = await getDocs(trackingQuery);

    let totalRevenue = 0;
    let korpoNetRevenue = 0;
    let partnerRevenue = 0;
    let totalDiscountGiven = 0;
    const userSet = new Set();

    if (!trackingSnap.empty) {
      trackingSnap.forEach((docSnap) => {
        const data = docSnap.data();

        totalRevenue += data.finalAmount || 0;
        korpoNetRevenue += data.companyRevenue || 0;
        partnerRevenue += data.partnerRevenue || 0;
        totalDiscountGiven += data.discountAmount || 0;

        if (data.userId) userSet.add(data.userId);
      });
    }

    const totalMembers = userSet.size;

    // 2️⃣ Fetch latest promo code details for this partner
    const promoQuery = query(
      collection(db, "promoCodes"),
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
        promoCode: latestPromo.promoCode || null,
        usageLimit,
        timesUsed,
        leftPromo,
        validTo: latestPromo.validTo || null,
      };
    }

    // 3️⃣ Fetch partner document (for availableBalance and other details)
    const partnerRef = doc(db, "partners", partnerId);
    const partnerSnap = await getDoc(partnerRef);

    let availableBalance = 0;
    if (partnerSnap.exists()) {
      const partnerData = partnerSnap.data();
      availableBalance = partnerData.availableBalance || 0;
    }

    // ✅ Always return a response
    res.json({
      partnerId,
      totalRevenue,
      korpoNetRevenue,
      partnerRevenue,
      totalDiscountGiven,
      totalMembers,
      availableBalance, // ✅ now included
      ...promoDetails,
    });
  } catch (error) {
    console.error("🔥 Error fetching partner stats:", error.message);
    res.status(500).json({ error: error.message });
  }
});



// /api/partner / stats / monthly /: partnerId
// :white_check_mark: Monthly Status API
// ✅ Monthly Stats for a Partner
app.get("/api/partner/stats/monthly/:partnerId", async (req, res) => {
  try {
    const { partnerId } = req.params;
    if (!partnerId) {
      return res.status(400).json({ error: "partnerId is required" });
    }

    // 1️⃣ Fetch all promo codes for this partner
    const promoQuery = query(
      collection(db, "promoCodes"),
      where("partnerId", "==", partnerId)
    );
    const promoSnap = await getDocs(promoQuery);

    let totalPromoCodes = promoSnap.size;
    let leftPromoCodes = 0;
    promoSnap.forEach((doc) => {
      const data = doc.data();
      if (typeof data.usageLimit === "number" && typeof data.timesUsed === "number") {
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
      let usedAt = null;

      if (data.usedAt) {
        if (typeof data.usedAt.toDate === "function") {
          usedAt = data.usedAt.toDate();
        } else {
          usedAt = new Date(data.usedAt);
        }
      }

      if (usedAt && usedAt >= firstDayOfMonth && usedAt <= lastDayOfMonth) {
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

    // 3️⃣ Get latest promo code details
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

    // ✅ Format month like "September 2025"
    const monthFormatted = now.toLocaleString("en-US", { month: "long", year: "numeric" });

    // 4️⃣ Response
    res.json({
      partnerId,
      totalPromoCodes,
      leftPromoCodes,
      monthlyTotalRevenue: monthlyTotalFinalAmount,
      monthlyKorpoNetRevenue: monthlyTotalCompanyRevenue,
      monthlyPartnerRevenue: monthlyTotalPartnerRevenue,
      monthlyTotalDiscountGiven,
      monthlyNewMembers,
      month: monthFormatted,
      ...promoDetails,
    });

  } catch (error) {
    console.error("🔥 Error fetching monthly stats:", error.message);
    res.status(500).json({ error: error.message });
  }
});


// _________________________AMBASSADOR ROUTES_________________________

// ✅ Submit Ambassador Application 
app.post("/api/ambassador/submitApplication", async (req, res) => {
  console.log("📩 Incoming ambassador application:", req.body);

  try {
    const { userId, firstName, lastName, email, socialLinks, whyJoin, referralCode } = req.body;

    // 1️⃣ Validate required fields
    if (!userId || !firstName || !lastName || !email || !whyJoin) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields. Please complete all fields before submitting.",
      });
    }

    // 2️⃣ Check if ambassador profile already exists
    const ambassadorRef = doc(db, "ambassadors", userId);
    const ambassadorSnap = await getDoc(ambassadorRef);

    if (ambassadorSnap.exists()) {
      const existing = ambassadorSnap.data();
      if (existing.status === "pending" || existing.status === "approved") {
        return res.status(400).json({
          success: false,
          error: "You already have a pending or approved ambassador profile.",
        });
      }
    }

    // 3️⃣ Generate unique referral code
    let finalCode = referralCode || "";
    let isUnique = false;

    while (!isUnique) {
      if (!finalCode) finalCode = `AMB${userId.slice(-4).toUpperCase()}`;

      const q = query(collection(db, "referralCodes"), where("referralCode", "==", finalCode));
      const existing = await getDocs(q);

      if (existing.empty) {
        isUnique = true;
      } else {
        if (referralCode) {
          return res.status(400).json({
            success: false,
            error: "Referral code already exists. Please choose another one.",
          });
        }
        finalCode = ""; // regenerate until unique
      }
    }

    // 4️⃣ Create referral code record
    const referralData = {
      ambassadorId: userId,
      referralCode: finalCode,
      status: "pending",
      validFrom: null,
      validTo: null,
      usageLimit: 100,
      timesUsed: 0,
      createdAt: serverTimestamp(),
    };
    const referralRef = await addDoc(collection(db, "referralCodes"), referralData);

    // 5️⃣ Create or update ambassador profile directly
    const ambassadorData = {
      userId,
      firstName,
      lastName,
      email,
      socialLinks: socialLinks || {},
      whyJoin,
      status: "pending",
      referralCode: finalCode,
      referralCodeId: referralRef.id,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      commissionRate: 0.1,
      totalReferrals: 0,
      availableBalance: 0,
    };

    await setDoc(ambassadorRef, ambassadorData, { merge: true });

    // 6️⃣ Update user document with ambassador info
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      ambassadorApplication: {
        status: "pending",
        createdAt: new Date(),
        ambassadorId: userId,
      },
      hasAppliedForAmbassador: true,
    });

    // 7️⃣ Send response back
    return res.status(201).json({
      success: true,
      message: "Your application has been submitted successfully!",
      ambassador: { id: userId, ...ambassadorData },
      referral: { id: referralRef.id, ...referralData },
    });

  } catch (error) {
    console.error("🔥 Error submitting ambassador application:", error);
    return res.status(500).json({
      success: false,
      error: "Something went wrong while submitting your application. Please try again later.",
    });
  }
});

// ✅ Update Ambassador Application Status (Approve / Decline / etc.)
app.post("/api/ambassador/updateStatus", async (req, res) => {
  console.log("📩 Update Ambassador Application Request:", req.body);

  try {
    const { userId, newStatus } = req.body;

    if (!userId || !newStatus) {
      return res.status(400).json({ success: false, error: "Missing user ID or status" });
    }

    // 1️⃣ Fetch ambassador profile
    const ambassadorsRef = doc(db, "ambassadors", userId);
    const ambassadorSnap = await getDoc(ambassadorsRef);
    if (!ambassadorSnap.exists()) {
      return res.status(404).json({ success: false, error: "Ambassador profile not found." });
    }

    const ambassadorData = ambassadorSnap.data();

    // 2️⃣ Get referral code (if exists)
    const q = query(collection(db, "referralCodes"), where("ambassadorId", "==", userId));
    const referralSnap = await getDocs(q);

    let updatedReferralCode = null;
    let updatedReferralId = null;
    const validFrom = new Date();
    const validTo = new Date(validFrom);
    validTo.setDate(validTo.getDate() + 100);

    if (!referralSnap.empty) {
      // Use existing referral code
      const referralDoc = referralSnap.docs[0];
      const referralRef = doc(db, "referralCodes", referralDoc.id);
      const referralData = referralDoc.data();

      updatedReferralCode = referralData.referralCode;
      updatedReferralId = referralDoc.id;

      if (newStatus === "approved") {
        let finalValidFrom = referralData.validFrom;
        let finalValidTo = referralData.validTo;

        // ✅ Only set validFrom/validTo if they are missing or expired
        const now = new Date();
        if (!finalValidFrom || !finalValidTo || new Date(finalValidTo) < now) {
          finalValidFrom = now;
          finalValidTo = new Date(now);
          finalValidTo.setDate(finalValidTo.getDate() + 100);
        }

        await updateDoc(referralRef, {
          status: "active",
          validFrom: finalValidFrom,
          validTo: finalValidTo,
        });

      } else if (newStatus === "declined") {
        // ❌ Deactivate but keep validity range intact
        await updateDoc(referralRef, { status: "inactive" });
      }
    }

    // 3️⃣ Update ambassador profile
    if (newStatus === "approved") {
      await updateDoc(ambassadorsRef, {
        status: "approved",
        ambassadorSince: ambassadorData.ambassadorSince || new Date(),
        updatedAt: new Date(),
        ...(updatedReferralCode && {
          referralCode: updatedReferralCode,
          referralCodeId: updatedReferralId,
          referralCodeValidTo: validTo,
        }),
      });
    } else if (newStatus === "declined") {
      await updateDoc(ambassadorsRef, {
        status: "declined",
        updatedAt: new Date(),
        referralCode: updatedReferralCode || null,
        referralCodeId: updatedReferralId || null,
      });
    } else {
      await updateDoc(ambassadorsRef, { status: newStatus, updatedAt: new Date() });
    }

    // 4️⃣ Update user document
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) return res.status(404).json({ success: false, error: "User not found." });

    const userData = userSnap.data();
    await updateDoc(userRef, {
      isAmbassador: newStatus === "approved",
      ambassadorApplication: {
        ...(userData.ambassadorApplication || {}),
        status: newStatus,
        updatedAt: new Date(),
      },
    });

    // 5️⃣ Respond
    return res.status(200).json({
      success: true,
      message:
        newStatus === "approved"
          ? `✅ Application approved. Referral code ${updatedReferralCode || "(none)"} activated.`
          : newStatus === "declined"
            ? "❌ Application declined. Referral code deactivated."
            : `ℹ️ Ambassador status updated to ${newStatus}`,
      referralCode: updatedReferralCode,
      referralCodeId: updatedReferralId,
    });

  } catch (error) {
    console.error("🔥 Error updating ambassador application:", error);
    return res.status(500).json({
      success: false,
      error: "Something went wrong while updating the ambassador status.",
      details: error.message,
    });
  }
});

// ✅ Use Referral Code
app.post("/api/referralCode/use/:code", async (req, res) => {
  try {
    const { userId, amount } = req.body; // 📝 userId & optional amount

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // 1️⃣ Check if user exists
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    // 2️⃣ Find referral code
    const referralQuery = query(
      collection(db, "referralCodes"),
      where("referralCode", "==", req.params.code)
    );
    const referralSnap = await getDocs(referralQuery);
    if (referralSnap.empty) {
      return res.status(404).json({ error: "Referral code not found" });
    }

    const referralDoc = referralSnap.docs[0];
    const referralRef = referralDoc.ref;
    const referralData = referralDoc.data();

    // 3️⃣ Validate referral code status & validity dates
    const now = new Date();
    if (referralData.status !== "active") {
      return res.status(400).json({ error: "Referral code is not active" });
    }
    if (referralData.validFrom && new Date(referralData.validFrom) > now) {
      return res.status(400).json({ error: "Referral code is not valid yet" });
    }
    if (referralData.validTo && new Date(referralData.validTo) < now) {
      return res.status(400).json({ error: "Referral code has expired" });
    }

    // 4️⃣ Check usage limit
    const timesUsed = referralData.timesUsed || 0;
    if (
      referralData.usageLimit !== null &&
      referralData.usageLimit !== undefined &&
      timesUsed >= referralData.usageLimit
    ) {
      return res.status(400).json({ error: "Referral code usage limit reached" });
    }

    const ambassadorId = referralData.ambassadorId;

    // 5️⃣ Prevent duplicate usage by same user
    const prevUsageQuery = query(
      collection(db, "referralTracking"),
      where("userId", "==", userId),
      where("referralCode", "==", req.params.code)
    );
    const prevUsageSnap = await getDocs(prevUsageQuery);
    if (!prevUsageSnap.empty) {
      return res.status(400).json({ error: "User already used this referral code" });
    }

    // 6️⃣ Find ambassador (for revenue share & tracking)
    let ambassadorData = null;
    let ambassadorRef = null;
    if (ambassadorId) {
      ambassadorRef = doc(db, "ambassadors", ambassadorId);
      const ambassadorSnap = await getDoc(ambassadorRef);
      if (ambassadorSnap.exists()) {
        ambassadorData = ambassadorSnap.data();
      }
    }

    // 7️⃣ Calculate commission
    const commissionRate = ambassadorData?.commissionRate ?? 0.1; // default 10%
    const commissionEarned = amount ? amount * commissionRate : 0;

    // 8️⃣ Increment timesUsed in referral code
    await updateDoc(referralRef, { timesUsed: increment(1) });

    // 9️⃣ Log usage in referralTracking
    const trackingData = {
      userId,
      ambassadorId: ambassadorId || null,
      referralCode: req.params.code,
      referralId: referralDoc.id,
      usedAt: now,
      amount: amount ?? null,
      commissionRate,
      commissionEarned,
    };
    await addDoc(collection(db, "referralTracking"), trackingData);

    // 🔟 Update ambassador profile stats
    if (ambassadorRef) {
      await updateDoc(ambassadorRef, {
        totalReferrals: increment(1),
        totalAmbassadorRevenue: increment(commissionEarned), // all-time revenue
        availableBalance: increment(commissionEarned), // can withdraw later
        ...(amount && {
          commissionEarned: increment(commissionEarned), // running commission
        }),
        lastReferralUsedAt: now,
      });
    }

    // 🔟 Respond back
    return res.json({
      message: `Referral code ${req.params.code} used successfully ✅`,
      ambassadorId,
      commissionEarned,
      commissionRate,
      timesUsed: timesUsed + 1,
      usageLimit: referralData.usageLimit ?? null,
    });

  } catch (error) {
    console.error("🔥 Error using referral code:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ✅ Get overall Ambassador Stats (all-time)
app.get("/api/ambassador/stats/:ambassadorId", async (req, res) => {
  try {
    const { ambassadorId } = req.params;

    if (!ambassadorId) {
      return res.status(400).json({ error: "ambassadorId is required" });
    }

    // 1️⃣ Fetch ambassador profile
    const ambassadorRef = doc(db, "ambassadors", ambassadorId);
    const ambassadorSnap = await getDoc(ambassadorRef);
    if (!ambassadorSnap.exists()) {
      return res.status(404).json({ error: "Ambassador not found" });
    }
    const ambassadorData = ambassadorSnap.data();

    // 2️⃣ Fetch all referral tracking entries for this ambassador
    const trackingQuery = query(
      collection(db, "referralTracking"),
      where("ambassadorId", "==", ambassadorId)
    );
    const trackingSnap = await getDocs(trackingQuery);

    const uniqueUsers = new Set();
    if (!trackingSnap.empty) {
      trackingSnap.forEach((doc) => {
        const data = doc.data();
        if (data.userId) uniqueUsers.add(data.userId);
      });
    }

    // 3️⃣ Fetch referral code info
    const referralQuery = query(
      collection(db, "referralCodes"),
      where("ambassadorId", "==", ambassadorId)
    );
    const referralSnap = await getDocs(referralQuery);

    let referralDetails = {};
    if (!referralSnap.empty) {
      const referralDoc = referralSnap.docs[0];
      const data = referralDoc.data();

      // Calculate remaining usage & validity dynamically
      const now = new Date();
      const validFrom = data.validFrom ? new Date(data.validFrom) : null;
      const validTo = data.validTo ? new Date(data.validTo) : null;
      const daysRemaining = validTo ? Math.max(0, Math.ceil((validTo - now) / (1000 * 60 * 60 * 24))) : null;

      let leftUses = null;
      if (data.usageLimit !== null && data.usageLimit !== undefined) {
        leftUses = Math.max(0, data.usageLimit - (data.timesUsed || 0));
      }

      referralDetails = {
        referralCode: data.referralCode,
        status: data.status,
        usageLimit: data.usageLimit ?? null,
        timesUsed: data.timesUsed || 0,
        leftUses,
        validFrom,
        validTo,
        daysRemaining,
        isExpired: validTo ? validTo < now : false,
        isActive: data.status === "active",
      };
    }

    // 4️⃣ Respond with stats
    res.json({
      ambassadorId,
      ambassadorSince: ambassadorData.ambassadorSince || null,
      commissionRate: ambassadorData.commissionRate ?? 0.1,
      totalAmbassadorRevenue: ambassadorData.totalAmbassadorRevenue || 0, // ✅ All-time revenue
      availableBalance: ambassadorData.availableBalance || 0, // ✅ Withdrawable balance
      lastReferralUsedAt: ambassadorData.lastReferralUsedAt || null,
      totalReferrals: uniqueUsers.size,
      referralDetails,
    });

  } catch (error) {
    console.error("🔥 Error fetching ambassador stats:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Get Monthly Ambassador Stats (current month only)
app.get("/api/ambassador/stats/monthly/:ambassadorId", async (req, res) => {
  try {
    const { ambassadorId } = req.params;

    if (!ambassadorId) {
      return res.status(400).json({ error: "ambassadorId is required" });
    }

    // 1️⃣ Calculate date range for current month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // 2️⃣ Fetch referral tracking entries for this ambassador in current month
    const trackingQuery = query(
      collection(db, "referralTracking"),
      where("ambassadorId", "==", ambassadorId),
      where("usedAt", ">=", startOfMonth),
      where("usedAt", "<", startOfNextMonth)
    );

    const trackingSnap = await getDocs(trackingQuery);

    let monthlyRevenue = 0;
    let monthlyReferrals = 0;
    const uniqueUsers = new Set();

    if (!trackingSnap.empty) {
      trackingSnap.forEach((doc) => {
        const data = doc.data();
        monthlyRevenue += data.commissionEarned || 0;
        monthlyReferrals++;
        if (data.userId) uniqueUsers.add(data.userId);
      });
    }

    // 3️⃣ Fetch ambassador profile (for commissionRate and balances)
    const ambassadorRef = doc(db, "ambassadors", ambassadorId);
    const ambassadorSnap = await getDoc(ambassadorRef);
    if (!ambassadorSnap.exists()) {
      return res.status(404).json({ error: "Ambassador not found" });
    }
    const ambassadorData = ambassadorSnap.data();

    // 4️⃣ Fetch referral code details (optional for UI)
    const referralQuery = query(
      collection(db, "referralCodes"),
      where("ambassadorId", "==", ambassadorId)
    );
    const referralSnap = await getDocs(referralQuery);

    let referralDetails = {};
    if (!referralSnap.empty) {
      const referralDoc = referralSnap.docs[0];
      const data = referralDoc.data();

      referralDetails = {
        referralCode: data.referralCode,
        status: data.status,
        timesUsed: data.timesUsed || 0,
      };
    }

    // 5️⃣ Respond
    res.json({
      ambassadorId,
      month: now.toLocaleString("default", { month: "long", year: "numeric" }),
      commissionRate: ambassadorData.commissionRate ?? 0.1,
      monthlyRevenue,
      monthlyReferrals,
      uniqueMonthlyUsers: uniqueUsers.size,
      referralDetails,
    });

  } catch (error) {
    console.error("🔥 Error fetching monthly stats:", error.message);
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

app.post("/api/ambassador/requestPayout", async (req, res) => {
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

app.post("/api/ambassador/approvePayout", async (req, res) => {
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

    // 3️⃣ Calculate payout 
    const payoutAmount = ambassador.availableBalance;
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

    // 6️⃣ Deduct balance from ambassador
    await updateDoc(ambassadorRef, {
      availableBalance: 0, // because we just paid out everything
      lastPayoutAt: serverTimestamp(),
    });

    // 7️⃣ Prepare nice response
    const formattedAmount = payoutAmount.toFixed(2);
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

app.post("/api/ambassador/cancelPayout", async (req, res) => {
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

app.post("/api/partner/requestPayout", async (req, res) => {
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

    const balance = partner?.totalPartnerRevenue || 0; // Adjust field name if different
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

app.post("/api/partner/approvePayout", async (req, res) => {
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

    // 3️⃣ Calculate payout
    const payoutAmount = partner.availableBalance || 0; // ✅ use availableBalance
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
      amount: payoutAmount,
    });

    // 6️⃣ Reset available balance for partner
    await updateDoc(partnerRef, {
      availableBalance: 0,
      lastPayoutAt: serverTimestamp(),
    });

    // 7️⃣ Prepare response
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


app.post("/api/partner/cancelPayout", async (req, res) => {
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
