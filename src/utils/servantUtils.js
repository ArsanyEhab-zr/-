import { normalizeArabicName } from './nameUtils';

/**
 * 🛡️ Cleans a phone number by removing spaces, dashes, and country prefixes for comparison.
 * 
 * @param {string|number} phone 
 * @returns {string}
 */
export function cleanPhoneNumber(phone) {
    if (!phone) return '';
    let cleaned = String(phone).trim().replace(/\D/g, '');
    // Strip leading Egyptian country code (+20 or 20) if followed by 10/11/12/15
    if (cleaned.startsWith('20') && cleaned.length === 12) {
        cleaned = '0' + cleaned.slice(2);
    }
    return cleaned;
}

/**
 * 👑 Builds a multi-key canonical index for a list of servants.
 * Allows instant O(1) resolution by:
 * - UID
 * - ID
 * - Cleaned Phone
 * - Normalized Arabic Name
 * 
 * @param {Array<object>} servantsList 
 * @returns {object} { resolveServant(identifierOrRecord), canonicalMap }
 */
export function buildCanonicalServantIndex(servantsList = []) {
    const byUid = new Map();
    const byId = new Map();
    const byPhone = new Map();
    const byName = new Map();
    const canonicalList = [];

    servantsList.forEach((s, index) => {
        if (!s) return;
        const canonicalId = String(s.uid || s.id || s.phone || `servant_${index}`);
        const canonicalServant = {
            ...s,
            canonicalId,
            uid: s.uid || canonicalId,
            id: s.id || canonicalId,
            name: s.name || '',
            phone: s.phone || '',
            role: s.role || 'خادم',
            assignedOsra: s.assignedOsra || s.osraName || s.syncKey || 'غير محدد',
            syncKey: s.syncKey || ''
        };

        canonicalList.push(canonicalServant);

        if (s.uid) byUid.set(String(s.uid), canonicalServant);
        if (s.id) byId.set(String(s.id), canonicalServant);
        
        const cleanPhone = cleanPhoneNumber(s.phone);
        if (cleanPhone) byPhone.set(cleanPhone, canonicalServant);

        const normName = normalizeArabicName(s.name);
        if (normName) byName.set(normName, canonicalServant);
    });

    /**
     * Resolves a record or identifier to the canonical servant object.
     * 
     * @param {object|string} query - Can be a servant attendance record, an ID, a phone, or a name
     * @returns {object|null} The canonical servant or null
     */
    function resolveServant(query) {
        if (!query) return null;

        if (typeof query === 'string') {
            const cleanStr = query.trim();
            if (byUid.has(cleanStr)) return byUid.get(cleanStr);
            if (byId.has(cleanStr)) return byId.get(cleanStr);

            const phoneClean = cleanPhoneNumber(cleanStr);
            if (phoneClean && byPhone.has(phoneClean)) return byPhone.get(phoneClean);

            const normName = normalizeArabicName(cleanStr);
            if (normName && byName.has(normName)) return byName.get(normName);

            return null;
        }

        // If query is an object (e.g. Attendance document)
        if (query.uid && byUid.has(String(query.uid))) return byUid.get(String(query.uid));
        if (query.id && byId.has(String(query.id))) return byId.get(String(query.id));

        const phoneVal = cleanPhoneNumber(query.phone || query.uid);
        if (phoneVal && byPhone.has(phoneVal)) return byPhone.get(phoneVal);

        const nameVal = normalizeArabicName(query.name);
        if (nameVal && byName.has(nameVal)) return byName.get(nameVal);

        return null;
    }

    return {
        canonicalList,
        resolveServant,
        byUid,
        byId,
        byPhone,
        byName
    };
}
