/**
 * Normalizes Arabic names to handle spelling variations, diacritics, and whitespace.
 * e.g., '  مِينا  أحمد ' => 'مينا احمد'
 * 
 * @param {string} name
 * @returns {string}
 */
export function normalizeArabicName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .trim()
        .toLowerCase()
        // Remove Arabic diacritics (tashkeel: fatha, damma, kasra, sukun, shadda, tanween)
        .replace(/[\u064B-\u065F\u0670]/g, '')
        // Normalize alef variants: أ, إ, آ, ٱ -> ا
        .replace(/[أإآٱ]/g, 'ا')
        // Normalize teh marbuta: ة -> ه
        .replace(/ة/g, 'ه')
        // Normalize yaa variants: ى, ئ -> ي
        .replace(/[ىئ]/g, 'ي')
        // Normalize multiple spaces into single space
        .replace(/\s+/g, ' ');
}

/**
 * Checks whether a name consists of a full 4-part (or more) Arabic name.
 * Used to prevent false-positive deduplication on 2-part or 3-part names.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function hasFullFourPartName(name) {
    const normalized = normalizeArabicName(name);
    if (!normalized) return false;
    const parts = normalized.split(' ').filter(Boolean);
    return parts.length >= 4;
}

/**
 * Converts Arabic/Persian digits to ASCII digits and normalizes an Egyptian/international phone number.
 * Returns empty string '' if the phone is missing, a placeholder, or shorter than 8 digits.
 *
 * @param {string|number} rawPhone
 * @returns {string}
 */
export function normalizePhoneNumber(rawPhone) {
    if (rawPhone === null || rawPhone === undefined) return '';
    let str = String(rawPhone).trim();
    if (!str || str === 'غير متوفر' || str === 'لا يوجد') return '';

    // Convert Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits
    str = str
        .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));

    // Strip all non-digit characters
    let digits = str.replace(/\D+/g, '');
    if (!digits) return '';

    // Normalize Egyptian country code prefixes (e.g., 00201... or 201... -> 01...)
    if (digits.startsWith('0020') && digits.length >= 14) {
        digits = '0' + digits.slice(4);
    } else if (digits.startsWith('20') && digits.length === 12) {
        digits = '0' + digits.slice(2);
    } else if (digits.length === 10 && digits.startsWith('1')) {
        digits = '0' + digits;
    }

    // Reject bogus all-zeros or too-short numbers
    if (digits.length < 8 || /^0+$/.test(digits)) return '';
    return digits;
}

/**
 * Extracts all valid normalized non-empty phone numbers belonging to a child record.
 *
 * @param {Object} child
 * @returns {string[]}
 */
export function getNormalizedChildPhones(child) {
    if (!child || typeof child !== 'object') return [];
    const candidates = [
        child.fatherPhone,
        child.motherPhone,
        child.childPhone,
        child.phone,
        child.whatsapp
    ];
    const unique = new Set();
    for (const c of candidates) {
        const norm = normalizePhoneNumber(c);
        if (norm) unique.add(norm);
    }
    return Array.from(unique);
}

/**
 * Returns the primary normalized non-empty phone number for a child (or '').
 *
 * @param {Object} child
 * @returns {string}
 */
export function getPrimaryNormalizedPhone(child) {
    const phones = getNormalizedChildPhones(child);
    return phones.length > 0 ? phones[0] : '';
}

/**
 * Builds a legacy composite key for class + normalized name.
 * Note: For destructive deduplication, always use `buildStrictDuplicateKey` or `areStrictDuplicateChildren`.
 * 
 * @param {string} syncKey
 * @param {string} name
 * @returns {string}
 */
export function buildClassChildNameKey(syncKey, name) {
    const sKey = String(syncKey || '').trim().toLowerCase();
    const nName = normalizeArabicName(name);
    return `${sKey}___${nName}`;
}

/**
 * Builds a strict composite key for duplicate detection:
 * ONLY returns a key when the child has a valid `syncKey`, a full 4-part normalized name,
 * AND a non-empty normalized phone number. Otherwise returns null so the child is NEVER
 * merged or deleted by fuzzy name matching.
 *
 * @param {Object} child
 * @param {string} [fallbackSyncKey]
 * @returns {string|null}
 */
export function buildStrictDuplicateKey(child, fallbackSyncKey = '') {
    if (!child || typeof child !== 'object') return null;
    const sKey = String(child.syncKey || fallbackSyncKey || '').trim().toLowerCase();
    if (!sKey) return null;
    if (!hasFullFourPartName(child.name)) return null;
    const nName = normalizeArabicName(child.name);
    const phone = getPrimaryNormalizedPhone(child);
    if (!phone) return null;
    return `${sKey}___${nName}___${phone}`;
}

/**
 * Determines whether two child records are true strict duplicates:
 * 1. Exact same non-empty `id` or `cloudId`, OR
 * 2. Exact same `syncKey` AND exact same normalized full 4-part name AND at least one exact matching non-empty normalized phone number.
 *
 * @param {Object} childA
 * @param {Object} childB
 * @param {string} [fallbackSyncKey]
 * @returns {boolean}
 */
export function areStrictDuplicateChildren(childA, childB, fallbackSyncKey = '') {
    if (!childA || !childB) return false;

    const idA = String(childA.cloudId || childA.id || '').trim();
    const idB = String(childB.cloudId || childB.id || '').trim();
    if (idA && idB && idA === idB) {
        return true;
    }

    const syncA = String(childA.syncKey || fallbackSyncKey || '').trim().toLowerCase();
    const syncB = String(childB.syncKey || fallbackSyncKey || '').trim().toLowerCase();
    if (!syncA || !syncB || syncA !== syncB) {
        return false;
    }

    if (!hasFullFourPartName(childA.name) || !hasFullFourPartName(childB.name)) {
        return false;
    }

    const nameA = normalizeArabicName(childA.name);
    const nameB = normalizeArabicName(childB.name);
    if (!nameA || nameA !== nameB) {
        return false;
    }

    const phonesA = getNormalizedChildPhones(childA);
    const phonesB = getNormalizedChildPhones(childB);
    if (phonesA.length === 0 || phonesB.length === 0) {
        return false;
    }

    return phonesA.some(p => phonesB.includes(p));
}

/**
 * Safely parses any timestamp representation (Date.now() number, numeric string, ISO string, Firestore Timestamp)
 * into milliseconds since epoch. Returns 0 if invalid or missing.
 *
 * @param {any} val
 * @returns {number}
 */
export function parseTimestampMs(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') {
        return Number.isFinite(val) ? val : 0;
    }
    if (typeof val === 'object') {
        if (typeof val.toMillis === 'function') {
            return val.toMillis();
        }
        if (typeof val.seconds === 'number') {
            return val.seconds * 1000;
        }
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) return 0;
        if (/^\d+$/.test(trimmed)) {
            const num = Number(trimmed);
            return Number.isFinite(num) ? num : 0;
        }
        const parsed = Date.parse(trimmed);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

/**
 * Extracts a flat list of all configured classes (osras) with their parent service info
 * from `appSettings` (or localStorage 'appSettings' fallback).
 *
 * @param {Object|null} [appSettingsInput]
 * @returns {Array<{ syncKey: string, name: string, serviceId: string, serviceName: string }>}
 */
export function getAllConfiguredOsras(appSettingsInput = null) {
    let settings = appSettingsInput;
    if (!settings && typeof localStorage !== 'undefined') {
        try {
            const raw = localStorage.getItem('appSettings');
            if (raw) settings = JSON.parse(raw);
        } catch (_) {}
    }
    if (!settings || typeof settings !== 'object') return [];

    const result = [];
    const seenKeys = new Set();

    if (Array.isArray(settings.khedmas)) {
        for (const khedma of settings.khedmas) {
            if (!khedma || !Array.isArray(khedma.osras)) continue;
            for (const osra of khedma.osras) {
                if (!osra || !osra.syncKey) continue;
                const key = String(osra.syncKey).trim();
                if (!key || seenKeys.has(key)) continue;
                seenKeys.add(key);
                result.push({
                    ...osra,
                    syncKey: key,
                    name: osra.name || key,
                    serviceId: khedma.id || osra.serviceId || '',
                    serviceName: khedma.name || 'خدمة مدارس الأحد'
                });
            }
        }
    }

    if (Array.isArray(settings.osras)) {
        for (const osra of settings.osras) {
            if (!osra || !osra.syncKey) continue;
            const key = String(osra.syncKey).trim();
            if (!key || seenKeys.has(key)) continue;
            seenKeys.add(key);
            const parentKhedma = Array.isArray(settings.khedmas)
                ? settings.khedmas.find(k => k.id === osra.serviceId)
                : null;
            result.push({
                ...osra,
                syncKey: key,
                name: osra.name || key,
                serviceId: osra.serviceId || parentKhedma?.id || '',
                serviceName: parentKhedma?.name || osra.serviceName || 'خدمة مدارس الأحد'
            });
        }
    }

    return result;
}

/**
 * Single Source of Truth for resolving a child's class name (`osraName`) and service name (`serviceName`)
 * strictly from `child.syncKey` mapped against `appSettings` (from `System/mainConfig`).
 *
 * @param {string} childSyncKey
 * @param {Object|null} [appSettingsInput]
 * @returns {{ syncKey: string, osraName: string, serviceName: string, serviceId: string, isKnown: boolean }}
 */
export function resolveChildClassInfo(childSyncKey, appSettingsInput = null) {
    const cleanKey = String(childSyncKey || '').trim();
    const allOsras = getAllConfiguredOsras(appSettingsInput);

    if (!cleanKey) {
        return {
            syncKey: '',
            osraName: 'غير محدد',
            serviceName: 'غير محدد',
            serviceId: '',
            isKnown: false
        };
    }

    // 1. Exact or case-insensitive syncKey match
    const exactMatch = allOsras.find(
        o => o.syncKey === cleanKey || o.syncKey.toLowerCase() === cleanKey.toLowerCase()
    );
    if (exactMatch) {
        return {
            syncKey: exactMatch.syncKey,
            osraName: exactMatch.name,
            serviceName: exactMatch.serviceName || 'خدمة مدارس الأحد',
            serviceId: exactMatch.serviceId || '',
            isKnown: true
        };
    }

    // 2. Fallback if legacy record accidentally stored Arabic class name in syncKey
    const normInput = normalizeArabicName(cleanKey);
    const nameMatch = allOsras.find(o => normalizeArabicName(o.name) === normInput);
    if (nameMatch) {
        return {
            syncKey: nameMatch.syncKey,
            osraName: nameMatch.name,
            serviceName: nameMatch.serviceName || 'خدمة مدارس الأحد',
            serviceId: nameMatch.serviceId || '',
            isKnown: true
        };
    }

    return {
        syncKey: cleanKey,
        osraName: cleanKey,
        serviceName: 'خدمة مدارس الأحد',
        serviceId: '',
        isKnown: false
    };
}

/**
 * Resolves a raw class identifier (either a `syncKey` code like "stage_1" or an Arabic class name like "حضانة")
 * to its canonical `osra.syncKey` from `appSettings`.
 *
 * @param {string} rawKeyOrName
 * @param {Object|null} [appSettingsInput]
 * @param {string} [fallbackSyncKey]
 * @returns {string}
 */
export function normalizeToValidSyncKey(rawKeyOrName, appSettingsInput = null, fallbackSyncKey = '') {
    const raw = String(rawKeyOrName || '').trim();
    const allOsras = getAllConfiguredOsras(appSettingsInput);

    if (raw && raw !== 'MASTER_ACCESS' && raw !== 'ADMIN_MODE' && raw !== 'STAGE_ADMIN' && raw !== 'غير محدد' && raw !== 'كل الأسر') {
        // 1. Direct syncKey match
        const byKey = allOsras.find(o => o.syncKey === raw || o.syncKey.toLowerCase() === raw.toLowerCase());
        if (byKey) return byKey.syncKey;

        // 2. Exact normalized Arabic name match
        const normRaw = normalizeArabicName(raw);
        if (normRaw) {
            const byName = allOsras.find(o => normalizeArabicName(o.name) === normRaw);
            if (byName) return byName.syncKey;
        }
    }

    const fb = String(fallbackSyncKey || '').trim();
    if (fb && fb !== 'MASTER_ACCESS' && fb !== 'ADMIN_MODE' && fb !== 'STAGE_ADMIN') {
        const byFb = allOsras.find(o => o.syncKey === fb || o.syncKey.toLowerCase() === fb.toLowerCase());
        if (byFb) return byFb.syncKey;
        return fb;
    }

    return raw && raw !== 'MASTER_ACCESS' && raw !== 'ADMIN_MODE' && raw !== 'STAGE_ADMIN' && raw !== 'غير محدد' && raw !== 'كل الأسر'
        ? raw
        : '';
}
