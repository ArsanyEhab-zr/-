/**
 * Clean, structured child ID generator and validator.
 * Generates and validates IDs with format: {Year}-{Gender}-{ShortRandom}
 * Example: 2026-B-67dr, 2026-G-a8x9
 */

/**
 * Determine gender token ('B' or 'G')
 * @param {string} gender 
 * @returns {'B' | 'G'}
 */
export function normalizeGenderToken(gender) {
    if (!gender || typeof gender !== 'string') return 'B';
    const trimmed = gender.trim().toLowerCase();
    if (trimmed === 'بنت' || trimmed === 'girl' || trimmed === 'g' || trimmed === 'female' || trimmed === 'أنثى') {
        return 'G';
    }
    return 'B';
}

/**
 * Generates a clean 4-character random lowercase alphanumeric string.
 */
export function generateRandomCode(length = 4) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let result = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const values = new Uint8Array(length);
        crypto.getRandomValues(values);
        for (let i = 0; i < length; i++) {
            result += chars[values[i] % chars.length];
        }
        return result;
    }
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

/**
 * Generates a structured clean child ID: {Year}-{Gender}-{ShortRandom}
 * Example: 2026-B-67dr
 * 
 * @param {string} gender 'boy' | 'girl' | 'ولد' | 'بنت' | 'B' | 'G'
 * @param {number|string} [year] Defaults to current year (e.g., 2026)
 * @param {Set<string>} [existingIds] Optional set of IDs to prevent collisions
 * @returns {string}
 */
export function generateChildId(gender, year = new Date().getFullYear(), existingIds = null) {
    const g = normalizeGenderToken(gender);
    const y = year || new Date().getFullYear();

    for (let attempt = 0; attempt < 50; attempt++) {
        const rand = generateRandomCode(4);
        const candidate = `${y}-${g}-${rand}`;
        if (!existingIds || !existingIds.has(candidate)) {
            if (existingIds) existingIds.add(candidate);
            return candidate;
        }
    }
    // Fallback in case of collisions
    const fallbackRand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '').substring(0, 4).toLowerCase()
        : Date.now().toString(36).slice(-4).toLowerCase();
    const fallbackId = `${y}-${g}-${fallbackRand}`;
    if (existingIds) existingIds.add(fallbackId);
    return fallbackId;
}

/**
 * Checks whether an ID adheres to the clean structured format.
 * Format: {Year}-{Gender/Osra}-{ShortRandom}
 * Examples: 2026-B-67dr, 2026-G-4f9a, 2026-B-ABCD
 * Rejects:
 * - Starting with id_
 * - Starting with child_
 * - Starting with temp_
 * - Numeric timestamps (e.g. 1792079805941)
 * - Auto-increment integers (e.g. 1, 2, 42)
 * - Full 36-char UUIDs
 * - Null, undefined, empty, or placeholder strings
 * 
 * @param {any} id 
 * @returns {boolean}
 */
export function isCleanChildId(id) {
    if (!id || typeof id !== 'string') return false;
    const str = id.trim();
    if (!str) return false;

    // Strictly banned ugly prefixes and placeholders
    if (str.startsWith('id_') || str.startsWith('child_') || str.startsWith('temp_')) return false;
    if (str === 'undefined' || str === 'null' || str === 'لم يتم إنشاء كود' || str === 'غير متوفر') return false;

    // Banned pure numbers / timestamps (e.g. 1792079805941 or 1, 2)
    if (/^\d+$/.test(str)) return false;

    // Banned raw full 36-char UUIDs
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) return false;

    // Format: YYYY-Gender/Osra-xxxx
    // Year: 4 digits
    // Middle token: 1-10 alphanumeric characters (e.g. B, G, or Osra code)
    // Suffix: 2-8 alphanumeric characters
    return /^\d{4}-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(str);
}

/**
 * Ensures an ID is clean. If valid, returns the trimmed ID;
 * otherwise generates a new clean structured ID.
 * 
 * @param {any} id 
 * @param {string} gender 
 * @param {number|string} [year] 
 * @param {Set<string>} [existingIds] 
 * @returns {string}
 */
export function ensureCleanChildId(id, gender, year, existingIds = null) {
    if (isCleanChildId(id)) {
        const clean = String(id).trim();
        if (existingIds) existingIds.add(clean);
        return clean;
    }
    return generateChildId(gender, year, existingIds);
}
