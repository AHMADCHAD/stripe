// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
// import { getAnalytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries
// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,  
  authDomain: "korpoai-da5ef.firebaseapp.com",
  projectId: "korpoai-da5ef",
  storageBucket: "korpoai-da5ef.firebasestorage.app",
  messagingSenderId: "1054602644195",
  appId: "1:1054602644195:web:5acb0b2bb7faba06e653d6",
  measurementId: "G-K5DT538QX3"
};
// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
// const analytics = getAnalytics(app);
export { db }