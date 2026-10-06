export const TENANT_CONFIG = {
    APP_NAME: import.meta.env.VITE_APP_NAME || "تطبيق الخدمة",
    BISHOP: import.meta.env.VITE_BISHOP_NAME || "[BISHOP_NAME]",
    PRIESTS: import.meta.env.VITE_PRIESTS ? import.meta.env.VITE_PRIESTS.split(",") : ["[PRIEST_NAME_1]", "[PRIEST_NAME_2]"],
    DEFAULT_KHEDMA_LOGO: "",
    DEFAULT_OSRA_LOGO: "",
    APK_DOWNLOAD_LINK: import.meta.env.VITE_APK_DOWNLOAD_LINK || "https://example.com/download-app",
    MASTER_VIEW_NAME: "كل الخدمة",
    QR_INVALID_MESSAGE: "بطاقة غير صالحة"
};
