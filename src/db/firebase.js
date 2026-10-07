// src/db/firebase.js
import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";
import { getStorage } from "firebase/storage";
// (App Check removed for pure clean connection)// 🌟 بيانات سيرفرك إنت يا هندسة (Khedmety App)
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

// 1. تشغيل فايربيز
const app = initializeApp(firebaseConfig);

// 3. تشغيل الإحصائيات
export const analytics = getAnalytics(app);

// 4. 🌟 تشغيل وتصدير قاعدة البيانات بالاسمين عشان نرضي كل ملفات المشروع!
// 🌟 تفعيل قاعدة البيانات الأوفلاين (Offline Persistence) بشكل آمن - Modern V9+ API
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// 🧹 مسح الكاش بالكامل في حالة وجود داتا مشفرة قديمة
export const clearFirebaseCache = async () => {
    try {
        await terminate(db);
        await clearIndexedDbPersistence(db);
        window.location.reload();
    } catch (error) {
        // Silently fail to keep console perfectly clean
    }
};

export const firestore = db; // السطر ده هيخلي ملف sync.js يشتغل فوراً

// 5. المخزن (عشان الـ PDF بعدين)
export const storage = getStorage(app);