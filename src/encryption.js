import CryptoJS from 'crypto-js';

// 🚨 Persistent Offline Encryption Key Strategy
// 1. We first try to get the existing key from localStorage to ensure we can decrypt offline data.
// 2. If it doesn't exist (first run), we get it from env vars, and save it to localStorage forever.
const initSecretKey = () => {
    let savedKey = localStorage.getItem('koinonia_sec_key');
    if (savedKey) {
        return savedKey;
    }
    const newKey = import.meta.env.VITE_ENCRYPTION_SECRET || "Fallback_Key_If_Env_Fails";
    localStorage.setItem('koinonia_sec_key', newKey);
    return newKey;
};

const SECRET_KEY = initSecretKey();

export const encryptData = (data) => {
    try {
        // بنحول الداتا لنص، وبعدين نشفرها
        const jsonStr = JSON.stringify(data);
        return CryptoJS.AES.encrypt(jsonStr, SECRET_KEY).toString();
    } catch (error) {
        console.error("Encryption Error:", error);
        return null;
    }
};

export const decryptData = (ciphertext) => {
    if (!ciphertext) return null;
    
    // Support plain unencrypted objects gracefully
    if (typeof ciphertext === 'object') return ciphertext;
    
    // Support unencrypted JSON strings
    if (typeof ciphertext === 'string' && (ciphertext.startsWith('{') || ciphertext.startsWith('['))) {
        try { return JSON.parse(ciphertext); } catch (e) { return null; }
    }

    try {
        // بنفك الشفرة، ونرجعها داتا أصلية
        const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_KEY);
        const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
        if (!decryptedStr) return null;
        return JSON.parse(decryptedStr);
    } catch (error) {
        // Silently skip malformed or incorrectly encrypted data (Clean Console)
        return null;
    }
};