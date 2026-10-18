/* eslint-disable no-unused-vars */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Camera, MapPin, Save, UserCircle, Users, Shield, CheckCircle, CalendarCheck, Loader2, ImagePlus, Sparkles, Calendar, Heart, FileText } from 'lucide-react';
import { doc, getDoc, updateDoc, setDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { firestore } from '../db/firebase';
import { db } from '../db/database';
import { uploadImageToCloudinary } from '../utils/cloudinary';
import { compressImageToBase64, handleImageError } from '../utils/imageUtils';

// 🎨 Role badge config — color-coded for visual hierarchy
const ROLE_BADGES = {
    'كاهن':         { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200', glow: 'shadow-purple-500/20', emoji: '⛪' },
    'أدمن مساعد':   { bg: 'bg-amber-100',  text: 'text-amber-700',  border: 'border-amber-200',  glow: 'shadow-amber-500/20',  emoji: '👑' },
    'أمين مرحلة':   { bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-200',   glow: 'shadow-blue-500/20',   emoji: '🏅' },
    'أمين خدمة':    { bg: 'bg-sky-100',    text: 'text-sky-700',    border: 'border-sky-200',    glow: 'shadow-sky-500/20',    emoji: '📋' },
    'أمين أسرة':    { bg: 'bg-teal-100',   text: 'text-teal-700',   border: 'border-teal-200',   glow: 'shadow-teal-500/20',   emoji: '📋' },
    'خادم':         { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-200', glow: 'shadow-emerald-500/20', emoji: '✝️' },
    'Super Admin':  { bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-200',    glow: 'shadow-red-500/20',    emoji: '🔐' },
};

const DEFAULT_BADGE = { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200', glow: '', emoji: '👤' };

/**
 * ServantProfile — Smart Profile Modal
 * 
 * @param {Object} props
 * @param {Object|null} props.servantData - The servant to display. If null, defaults to the logged-in user (self-view).
 * @param {boolean}     props.isOpen      - Controls modal visibility.
 * @param {Function}    props.onClose     - Callback to close the modal.
 * @param {boolean}     props.readOnly    - If true, disables editing (admin view). Defaults to false.
 */
export default function ServantProfile({ servantData = null, isOpen = false, onClose, readOnly = false }) {
    // ─── Determine view mode ───
    // Use React state for currentServant so updates trigger re-renders
    const [localServant, setLocalServant] = useState(() => {
        try { return JSON.parse(localStorage.getItem('currentServant') || '{}'); } catch { return {}; }
    });
    const isSelfView = !servantData;
    const servant = servantData || localServant;
    const canEdit = isSelfView && !readOnly;

    // ─── State ───
    const [address, setAddress] = useState(servant.address || '');
    const [confessionFather, setConfessionFather] = useState(servant.confessionFather || servant.fatherConfessor || '');
    const [birthDate, setBirthDate] = useState(servant.birthDate || '');
    const [notes, setNotes] = useState(servant.notes || servant.specialNotes || '');
    const [photoURL, setPhotoURL] = useState(servant.photoURL || servant.profileImage || servant.profilePic || '');
    const [isUploading, setIsUploading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [attendanceCount, setAttendanceCount] = useState(null);
    const [isLoadingAttendance, setIsLoadingAttendance] = useState(true);
    const [editingAddress, setEditingAddress] = useState(false);
    const [editingConfession, setEditingConfession] = useState(false);
    const [editingBirthDate, setEditingBirthDate] = useState(false);
    const [editingNotes, setEditingNotes] = useState(false);
    const fileInputRef = useRef(null);

    // ─── Resolve the osra (family) name from appSettings ───
    const getOsraName = useCallback(() => {
        if (servant.assignedOsra) return servant.assignedOsra;
        try {
            const settings = JSON.parse(localStorage.getItem('appSettings') || '{}');
            const allOsras = settings.services?.flatMap(s => s.osras || []) || [];
            const found = allOsras.find(o => o.syncKey === servant.syncKey);
            return found?.name || servant.syncKey || 'غير محدد';
        } catch { return servant.syncKey || 'غير محدد'; }
    }, [servant.assignedOsra, servant.syncKey]);

    // ─── Stable key for servant identity (prevents infinite re-renders) ───
    const servantUID = servant.uid || servant.phone || '';

    // ─── Fetch all-time attendance count from Firestore ───
    useEffect(() => {
        if (!isOpen || !servantUID) {
            setAttendanceCount(0);
            setIsLoadingAttendance(false);
            return;
        }

        let cancelled = false;
        const fetchAttendance = async () => {
            setIsLoadingAttendance(true);
            try {
                // Query ServantAttendance where uid matches
                const attendanceRef = collection(firestore, 'ServantAttendance');
                const q = query(attendanceRef, where('uid', '==', servantUID));
                const snapshot = await getDocs(q);

                if (cancelled) return;

                let count = 0;
                snapshot.forEach(docSnap => {
                    const data = docSnap.data();
                    if (data.attendance === 'حضور') count++;
                });

                setAttendanceCount(count);
            } catch (error) {
                console.warn('[ServantProfile] Attendance fetch error:', error?.message || error);
                if (!cancelled) setAttendanceCount(0);
            } finally {
                if (!cancelled) setIsLoadingAttendance(false);
            }
        };
        fetchAttendance();

        return () => { cancelled = true; };
    }, [isOpen, servantUID]);

    // ─── Re-read localStorage when modal opens (in case data changed externally) ───
    useEffect(() => {
        if (isOpen && isSelfView) {
            try {
                const fresh = JSON.parse(localStorage.getItem('currentServant') || '{}');
                setLocalServant(fresh);
            } catch { /* ignore */ }
        }
    }, [isOpen, isSelfView]);

    // ─── Reset form fields when modal opens or servant identity changes ───
    useEffect(() => {
        if (isOpen) {
            setAddress(servant.address || '');
            setConfessionFather(servant.confessionFather || servant.fatherConfessor || '');
            setBirthDate(servant.birthDate || '');
            setNotes(servant.notes || servant.specialNotes || '');
            setPhotoURL(servant.photoURL || servant.profileImage || servant.profilePic || '');
            setSaveSuccess(false);
            setEditingAddress(false);
            setEditingConfession(false);
            setEditingBirthDate(false);
            setEditingNotes(false);
        }
    // Only reset when the modal opens or the servant identity changes, NOT on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, servantUID]);

    // ─── Image Upload Handler with Offline Fallback ───
    const handleImageUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Validate file type & size
        if (!file.type.startsWith('image/')) {
            alert('⚠️ يرجى اختيار صورة صالحة.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            alert('⚠️ حجم الصورة كبير جداً. الحد الأقصى 5 ميجا.');
            return;
        }

        setIsUploading(true);
        try {
            let downloadURL = null;
            if (navigator.onLine) {
                try {
                    downloadURL = await uploadImageToCloudinary(file, 'image');
                } catch (cloudErr) {
                    console.warn('[ServantProfile] Cloudinary failed, falling back to base64 compression:', cloudErr);
                }
            }
            if (!downloadURL) {
                downloadURL = await compressImageToBase64(file);
            }

            setPhotoURL(downloadURL);

            // Update Firestore & localStorage immediately across all aliases
            await updateServantData({
                photoURL: downloadURL,
                profilePic: downloadURL,
                profileImage: downloadURL
            });
        } catch (error) {
            console.error('[ServantProfile] Upload error:', error);
            alert('حدث خطأ أثناء معالجة الصورة. حاول مرة أخرى.');
        } finally {
            setIsUploading(false);
        }
    };

    // ─── Save address handler ───
    const handleSaveAddress = async () => {
        setIsSaving(true);
        try {
            await updateServantData({ address });
            setSaveSuccess(true);
            setEditingAddress(false);
            setTimeout(() => setSaveSuccess(false), 2500);
        } catch (error) {
            console.error('[ServantProfile] Save address error:', error);
            alert('حدث خطأ أثناء حفظ العنوان.');
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Save Confession Father ───
    const handleSaveConfession = async () => {
        setIsSaving(true);
        try {
            await updateServantData({ confessionFather, fatherConfessor: confessionFather });
            setSaveSuccess(true);
            setEditingConfession(false);
            setTimeout(() => setSaveSuccess(false), 2500);
        } catch (error) {
            console.error('[ServantProfile] Save confession father error:', error);
            alert('حدث خطأ أثناء حفظ أب الاعتراف.');
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Save Birthdate ───
    const handleSaveBirthDate = async () => {
        setIsSaving(true);
        try {
            await updateServantData({ birthDate });
            setSaveSuccess(true);
            setEditingBirthDate(false);
            setTimeout(() => setSaveSuccess(false), 2500);
        } catch (error) {
            console.error('[ServantProfile] Save birthdate error:', error);
            alert('حدث خطأ أثناء حفظ تاريخ الميلاد.');
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Save Notes ───
    const handleSaveNotes = async () => {
        setIsSaving(true);
        try {
            await updateServantData({ notes, specialNotes: notes });
            setSaveSuccess(true);
            setEditingNotes(false);
            setTimeout(() => setSaveSuccess(false), 2500);
        } catch (error) {
            console.error('[ServantProfile] Save notes error:', error);
            alert('حدث خطأ أثناء حفظ الملاحظات.');
        } finally {
            setIsSaving(false);
        }
    };

    // ─── Centralized update: Firestore + localStorage + Dexie + React state ───
    const updateServantData = async (updates) => {
        // Read the freshest localStorage copy (not stale closure)
        let freshServant;
        try { freshServant = JSON.parse(localStorage.getItem('currentServant') || '{}'); } catch { freshServant = localServant; }
        const uid = freshServant.uid || freshServant.phone;
        let updatedServantRecord = { ...freshServant, ...updates };

        console.log('[ServantProfile] Attempting update for UID:', uid, '| Updates:', JSON.stringify(updates));

        // 1. Update mainConfig.servants array in Firestore
        try {
            const configRef = doc(firestore, 'System', 'mainConfig');
            const configSnap = await getDoc(configRef);
            if (configSnap.exists()) {
                const config = configSnap.data();
                const servantsList = config.servants || [];

                // Robust matching: try phone first (most reliable), then uid
                const servantPhone = freshServant.phone;
                const servantUid = freshServant.uid;
                const idx = servantsList.findIndex(s =>
                    (servantPhone && s.phone === servantPhone) ||
                    (servantUid && s.uid === servantUid) ||
                    (freshServant.name && s.name === freshServant.name)
                );

                if (idx > -1) {
                    servantsList[idx] = { ...servantsList[idx], ...updates };
                    updatedServantRecord = servantsList[idx];

                    await updateDoc(configRef, { servants: servantsList });
                    console.log('[ServantProfile] ✅ Firestore mainConfig updated successfully');
                }
            }

            // Also update the servants collection doc if present
            if (freshServant.uid) {
                try {
                    const sDocRef = doc(firestore, 'servants', String(freshServant.uid));
                    await setDoc(sDocRef, updates, { merge: true });
                } catch (_) {}
            }
        } catch (err) {
            console.error('[ServantProfile] ❌ Firestore update error:', err);
        }

        // 2. Update localStorage (currentServant + appSettings)
        localStorage.setItem('currentServant', JSON.stringify(updatedServantRecord));

        try {
            const localSettings = JSON.parse(localStorage.getItem('appSettings') || '{}');
            const servantsList = localSettings.servants || [];
            const servantPhone = freshServant.phone;
            const servantUid = freshServant.uid;
            const idx = servantsList.findIndex(s =>
                (servantPhone && s.phone === servantPhone) ||
                (servantUid && s.uid === servantUid) ||
                (freshServant.name && s.name === freshServant.name)
            );

            if (idx > -1) {
                servantsList[idx] = { ...servantsList[idx], ...updates };
                localSettings.servants = servantsList;
                localStorage.setItem('appSettings', JSON.stringify(localSettings));
            }
        } catch (err) {
            console.error('[ServantProfile] ❌ localStorage update error:', err);
        }

        // 3. Update local Dexie DB for instant UI sync
        try {
            if (updatedServantRecord.phone) {
                const existing = await db.servants.where('phone').equals(updatedServantRecord.phone).first();
                if (existing) {
                    await db.servants.put({ ...existing, ...updates });
                } else if (updatedServantRecord.id) {
                    await db.servants.put(updatedServantRecord);
                }
            }
        } catch (err) {
            console.error('[ServantProfile] ❌ Dexie DB update error:', err);
        }

        // 4. Update React state so the UI re-renders instantly
        if (isSelfView) {
            setLocalServant(updatedServantRecord);
        }
        if (updates.photoURL) setPhotoURL(updates.photoURL);
        if (updates.address !== undefined) setAddress(updates.address);
        if (updates.confessionFather !== undefined) setConfessionFather(updates.confessionFather);
        if (updates.birthDate !== undefined) setBirthDate(updates.birthDate);
        if (updates.notes !== undefined) setNotes(updates.notes);

        // 5. Broadcast real-time profile update event across the entire application
        try {
            window.dispatchEvent(new CustomEvent('servant-updated', { detail: updatedServantRecord }));
            window.dispatchEvent(new Event('storage'));
        } catch (_) {}
    };

    // ─── Don't render if closed ───
    if (!isOpen) return null;

    const badge = ROLE_BADGES[servant.role] || DEFAULT_BADGE;
    const osraName = getOsraName();
    const initials = (servant.name || 'خ').substring(0, 2);

    return (
        <div className="fixed inset-0 z-[10000] flex items-end sm:items-center justify-center" dir="rtl">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

            {/* Modal Content */}
            <div className="relative w-full max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-[2.5rem] sm:rounded-[2.5rem] shadow-2xl animate-in slide-in-from-bottom-8 sm:slide-in-from-bottom-4 duration-500">
                
                {/* ═══ Header Gradient ═══ */}
                <div className="relative h-40 bg-gradient-to-br from-indigo-600 via-indigo-700 to-purple-800 rounded-t-[2.5rem] sm:rounded-t-[2.5rem] overflow-hidden">
                    {/* Decorative blobs */}
                    <div className="absolute -top-8 -right-8 w-32 h-32 bg-amber-400/20 rounded-full blur-2xl" />
                    <div className="absolute bottom-0 -left-4 w-24 h-24 bg-purple-400/30 rounded-full blur-xl" />
                    <div className="absolute top-4 left-2 w-16 h-16 bg-white/10 rounded-full blur-lg" />

                    {/* Close button */}
                    <button
                        onClick={onClose}
                        className="absolute top-4 left-4 w-10 h-10 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center text-white hover:bg-white/30 transition-all z-10"
                    >
                        <X size={20} />
                    </button>

                    {/* Self-view badge */}
                    {isSelfView && (
                        <div className="absolute top-4 right-4 flex items-center gap-1.5 bg-white/20 backdrop-blur-md px-3 py-1.5 rounded-full text-white text-[10px] font-black z-10">
                            <Sparkles size={12} /> ملفك الشخصي
                        </div>
                    )}
                </div>

                {/* ═══ Avatar (overlapping header) ═══ */}
                <div className="relative -mt-16 flex flex-col items-center mb-2 z-10">
                    <div className="relative group">
                        {photoURL ? (
                            <img
                                src={photoURL}
                                alt={servant.name}
                                onError={handleImageError}
                                className="w-28 h-28 rounded-full object-cover border-4 border-white shadow-xl bg-slate-100"
                            />
                        ) : (
                            <div className="w-28 h-28 rounded-full bg-gradient-to-br from-indigo-100 to-indigo-200 border-4 border-white shadow-xl flex items-center justify-center">
                                <span className="text-3xl font-black text-indigo-600">{initials}</span>
                            </div>
                        )}

                        {/* Upload button (self-view only) */}
                        {canEdit && (
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploading}
                                className="absolute bottom-0 right-0 w-9 h-9 bg-indigo-600 text-white rounded-full flex items-center justify-center shadow-lg border-2 border-white hover:bg-indigo-700 transition-all active:scale-90"
                            >
                                {isUploading ? (
                                    <Loader2 size={16} className="animate-spin" />
                                ) : (
                                    <Camera size={16} />
                                )}
                            </button>
                        )}

                        {/* Hidden file input */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleImageUpload}
                        />
                    </div>
                </div>

                {/* ═══ Body ═══ */}
                <div className="px-6 pb-8">
                    {/* Name */}
                    <h2 className="text-center text-2xl font-black text-slate-800 mb-2">{servant.name}</h2>

                    {/* Role Badge */}
                    <div className="flex justify-center mb-5">
                        <span className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-black border ${badge.bg} ${badge.text} ${badge.border} shadow-sm ${badge.glow}`}>
                            <span>{badge.emoji}</span>
                            {servant.role || 'خادم'}
                        </span>
                    </div>

                    {/* ═══ Info Cards ═══ */}
                    <div className="space-y-3">

                        {/* Family / Class Card */}
                        <div className="flex items-center gap-3 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                            <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-600 shrink-0">
                                <Users size={20} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[10px] font-bold text-indigo-400 mb-0.5">الأسرة / الفصل</p>
                                <p className="text-sm font-black text-indigo-800 truncate">{osraName}</p>
                            </div>
                        </div>

                        {/* Phone Card */}
                        {servant.phone && (
                            <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                                <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 shrink-0">
                                    <Shield size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-bold text-slate-400 mb-0.5">رقم الهاتف</p>
                                    <p className="text-sm font-black text-slate-700 truncate" dir="ltr">{servant.phone}</p>
                                </div>
                            </div>
                        )}

                        {/* Address Card */}
                        <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center text-emerald-600 shrink-0">
                                    <MapPin size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-bold text-emerald-400 mb-0.5">العنوان</p>
                                    {canEdit && editingAddress ? (
                                        <div className="flex gap-2 items-center">
                                            <input
                                                type="text"
                                                value={address}
                                                onChange={(e) => setAddress(e.target.value)}
                                                placeholder="أدخل عنوانك..."
                                                className="flex-1 text-sm font-bold text-slate-700 bg-white border border-emerald-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-400"
                                                autoFocus
                                            />
                                            <button
                                                onClick={handleSaveAddress}
                                                disabled={isSaving}
                                                className="shrink-0 w-9 h-9 bg-emerald-500 text-white rounded-xl flex items-center justify-center hover:bg-emerald-600 transition-colors shadow-sm active:scale-90"
                                            >
                                                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-black text-emerald-800 flex-1 truncate">
                                                {address || servant.address || 'لم يتم إضافة عنوان'}
                                            </p>
                                            {canEdit && (
                                                <button
                                                    onClick={() => setEditingAddress(true)}
                                                    className="shrink-0 text-[10px] font-black text-emerald-600 bg-emerald-100 px-2.5 py-1 rounded-lg hover:bg-emerald-200 transition-colors"
                                                >
                                                    تعديل
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                            {saveSuccess && (
                                <div className="mt-2 flex items-center gap-1.5 text-emerald-600 text-xs font-black animate-in fade-in duration-300">
                                    <CheckCircle size={14} /> تم حفظ العنوان بنجاح!
                                </div>
                            )}
                        </div>

                        {/* Confession Father Card */}
                        <div className="p-4 bg-purple-50 rounded-2xl border border-purple-100">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center text-purple-600 shrink-0">
                                    <Heart size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-bold text-purple-400 mb-0.5">أب الاعتراف</p>
                                    {canEdit && editingConfession ? (
                                        <div className="flex gap-2 items-center">
                                            <input
                                                type="text"
                                                value={confessionFather}
                                                onChange={(e) => setConfessionFather(e.target.value)}
                                                placeholder="اسم أب الاعتراف..."
                                                className="flex-1 text-sm font-bold text-slate-700 bg-white border border-purple-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-purple-400"
                                                autoFocus
                                            />
                                            <button
                                                onClick={handleSaveConfession}
                                                disabled={isSaving}
                                                className="shrink-0 w-9 h-9 bg-purple-600 text-white rounded-xl flex items-center justify-center hover:bg-purple-700 transition-colors shadow-sm active:scale-90"
                                            >
                                                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-black text-purple-800 flex-1 truncate">
                                                {confessionFather || servant.confessionFather || servant.fatherConfessor || 'لم يتم تحديد أب الاعتراف'}
                                            </p>
                                            {canEdit && (
                                                <button
                                                    onClick={() => setEditingConfession(true)}
                                                    className="shrink-0 text-[10px] font-black text-purple-600 bg-purple-100 px-2.5 py-1 rounded-lg hover:bg-purple-200 transition-colors"
                                                >
                                                    تعديل
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Birthdate Card */}
                        <div className="p-4 bg-sky-50 rounded-2xl border border-sky-100">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-sky-100 flex items-center justify-center text-sky-600 shrink-0">
                                    <Calendar size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-bold text-sky-400 mb-0.5">تاريخ الميلاد</p>
                                    {canEdit && editingBirthDate ? (
                                        <div className="flex gap-2 items-center">
                                            <input
                                                type="date"
                                                value={birthDate}
                                                onChange={(e) => setBirthDate(e.target.value)}
                                                className="flex-1 text-sm font-bold text-slate-700 bg-white border border-sky-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-sky-400"
                                                autoFocus
                                            />
                                            <button
                                                onClick={handleSaveBirthDate}
                                                disabled={isSaving}
                                                className="shrink-0 w-9 h-9 bg-sky-600 text-white rounded-xl flex items-center justify-center hover:bg-sky-700 transition-colors shadow-sm active:scale-90"
                                            >
                                                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-black text-sky-800 flex-1 truncate">
                                                {birthDate || servant.birthDate || 'لم يتم تسجيل تاريخ الميلاد'}
                                            </p>
                                            {canEdit && (
                                                <button
                                                    onClick={() => setEditingBirthDate(true)}
                                                    className="shrink-0 text-[10px] font-black text-sky-600 bg-sky-100 px-2.5 py-1 rounded-lg hover:bg-sky-200 transition-colors"
                                                >
                                                    تعديل
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Notes Card */}
                        <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center text-amber-600 shrink-0">
                                    <FileText size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-bold text-amber-500 mb-0.5">ملاحظات شخصية</p>
                                    {canEdit && editingNotes ? (
                                        <div className="flex gap-2 items-center">
                                            <input
                                                type="text"
                                                value={notes}
                                                onChange={(e) => setNotes(e.target.value)}
                                                placeholder="أدخل أي ملاحظات..."
                                                className="flex-1 text-sm font-bold text-slate-700 bg-white border border-amber-200 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-amber-400"
                                                autoFocus
                                            />
                                            <button
                                                onClick={handleSaveNotes}
                                                disabled={isSaving}
                                                className="shrink-0 w-9 h-9 bg-amber-600 text-white rounded-xl flex items-center justify-center hover:bg-amber-700 transition-colors shadow-sm active:scale-90"
                                            >
                                                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-black text-amber-800 flex-1 truncate">
                                                {notes || servant.notes || servant.specialNotes || 'لا توجد ملاحظات'}
                                            </p>
                                            {canEdit && (
                                                <button
                                                    onClick={() => setEditingNotes(true)}
                                                    className="shrink-0 text-[10px] font-black text-amber-600 bg-amber-100 px-2.5 py-1 rounded-lg hover:bg-amber-200 transition-colors"
                                                >
                                                    تعديل
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* ═══ Attendance Counter — Big Stat Card ═══ */}
                        <div className="mt-4 p-5 bg-gradient-to-br from-indigo-900 to-indigo-950 rounded-3xl border border-indigo-500/20 shadow-xl relative overflow-hidden">
                            {/* Decorative */}
                            <div className="absolute -top-6 -left-6 w-24 h-24 bg-amber-400/10 rounded-full blur-2xl" />
                            <div className="absolute bottom-0 right-0 w-16 h-16 bg-indigo-400/20 rounded-full blur-xl" />

                            <div className="relative z-10 flex items-center gap-4">
                                <div className="w-14 h-14 rounded-2xl bg-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
                                    <CalendarCheck size={28} />
                                </div>
                                <div className="flex-1">
                                    <p className="text-xs font-bold text-indigo-300 mb-1">إجمالي مرات الحضور</p>
                                    {isLoadingAttendance ? (
                                        <div className="flex items-center gap-2">
                                            <Loader2 size={20} className="text-amber-400 animate-spin" />
                                            <span className="text-sm font-bold text-indigo-300">جاري الحساب...</span>
                                        </div>
                                    ) : (
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-4xl font-black text-white">{attendanceCount}</span>
                                            <span className="text-sm font-bold text-indigo-400">مرة</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Mini description */}
                            <p className="text-[10px] font-bold text-indigo-400 mt-3 relative z-10">
                                يشمل جميع سجلات الحضور المسجلة من بداية الخدمة
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
