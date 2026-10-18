import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/database';
import { ShieldAlert, Key, Phone, User, LogIn, Loader2 } from 'lucide-react';
import { firestore } from '../db/firebase';
import { collection, getDocs, collectionGroup, getDoc, doc } from 'firebase/firestore';
import { decryptData } from '../encryption';

export default function ParentLogin() {
    const navigate = useNavigate();
    const [classes, setClasses] = useState([]);
    const [selectedClass, setSelectedClass] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        // Fetch classes from local settings or Firestore
        const fetchClasses = async () => {
            let loadedClasses = [];
            
            // Try local first
            const savedSettings = localStorage.getItem('appSettings');
            if (savedSettings) {
                try {
                    const parsed = JSON.parse(savedSettings);
                    if (parsed.services) {
                        parsed.services.forEach(srv => {
                            if (srv.osras) {
                                srv.osras.forEach(osra => {
                                    loadedClasses.push({ name: osra.name, syncKey: osra.syncKey });
                                });
                            }
                        });
                    }
                } catch (e) {
                    console.error(e);
                }
            }

            // Fallback to Firestore if empty and online
            if (loadedClasses.length === 0 && navigator.onLine) {
                try {
                    const querySnapshot = await getDocs(collection(firestore, "System"));
                    querySnapshot.forEach(doc => {
                        const data = doc.data();
                        if (data.services) {
                            data.services.forEach(srv => {
                                if (srv.osras) {
                                    srv.osras.forEach(osra => {
                                        loadedClasses.push({ name: osra.name, syncKey: osra.syncKey });
                                    });
                                }
                            });
                        }
                    });
                } catch (e) {
                    console.error("Error fetching classes from Firestore:", e);
                }
            }
            
            // Remove duplicates
            const uniqueClasses = Array.from(new Set(loadedClasses.map(c => c.name)))
                .map(name => loadedClasses.find(c => c.name === name));
            
            setClasses(uniqueClasses);
        };
        fetchClasses();
    }, []);

    const handleLogin = async (e) => {
        e.preventDefault();
        setErrorMsg('');
        setIsLoading(true);

        const rawInput = phoneNumber.trim();
        const cleanPhone = rawInput.replace(/\D/g, '');
        const cleanIdUpper = rawInput.toUpperCase();

        try {
            const targetClass = classes.find(c => c.name === selectedClass);
            if (!targetClass) {
                setErrorMsg('الفصل المختار غير صالح.');
                setIsLoading(false);
                return;
            }

            let match = null;

            // 1. If offline, try to find child in local Dexie database
            if (!navigator.onLine) {
                const localChildren = await db.children.where('syncKey').equals(targetClass.syncKey).toArray();
                match = localChildren.find(c => {
                    const idMatch = cleanIdUpper && String(c.id).trim().toUpperCase() === cleanIdUpper;
                    const cPhone = c.phone ? String(c.phone).replace(/\D/g, '') : '';
                    const mPhone = c.motherPhone ? String(c.motherPhone).replace(/\D/g, '') : '';
                    const fPhone = c.fatherPhone ? String(c.fatherPhone).replace(/\D/g, '') : '';
                    const pPhone = c.childPhone ? String(c.childPhone).replace(/\D/g, '') : '';
                    const phoneMatch = cleanPhone && (
                        (cPhone && cPhone.includes(cleanPhone)) ||
                        (mPhone && mPhone.includes(cleanPhone)) ||
                        (fPhone && fPhone.includes(cleanPhone)) ||
                        (pPhone && pPhone.includes(cleanPhone))
                    );
                    return idMatch || phoneMatch;
                });

                if (match) {
                    localStorage.setItem('parentChildId', match.id);
                    localStorage.setItem('parentChildName', match.name);
                    localStorage.setItem('parentSyncKey', match.syncKey);
                    localStorage.setItem('parentClassName', selectedClass);
                    navigate('/parent-dashboard');
                    return;
                } else {
                    setErrorMsg('لا يوجد اتصال بالإنترنت، ولم يتم العثور على بيانات المخدوم محلياً.');
                    setIsLoading(false);
                    return;
                }
            }

            // 2. Query target class children collection first (fastest and most specific)
            let docsToScan = [];
            try {
                const classSnap = await getDocs(collection(firestore, 'Osras', targetClass.syncKey, 'children'));
                docsToScan = classSnap.docs || [];
            } catch (_) {}

            // Fallback to collectionGroup if class query yielded nothing
            if (docsToScan.length === 0) {
                const groupSnap = await getDocs(collectionGroup(firestore, 'children'));
                docsToScan = groupSnap.docs || [];
            }

            // 3. Loop and decrypt each child document to search for a match
            for (const docSnap of docsToScan) {
                const data = docSnap.data();
                if (data && docSnap.id !== '_placeholder') {
                    const decrypted = data.payload ? decryptData(data.payload) : data;
                    if (decrypted) {
                        const docSyncKey = docSnap.ref.parent?.parent?.id || targetClass.syncKey;
                        const childSyncKey = decrypted.syncKey || docSyncKey;

                        const matchesClass = childSyncKey === targetClass.syncKey || 
                                             decrypted.className === selectedClass || 
                                             decrypted.osraName === selectedClass;

                        if (matchesClass) {
                            const childDocId = String(decrypted.id || docSnap.id).trim().toUpperCase();
                            const matchesId = cleanIdUpper && childDocId === cleanIdUpper;

                            const legacyPhone = decrypted.phone ? String(decrypted.phone).trim().replace(/\D/g, '') : '';
                            const motherPhone = decrypted.motherPhone ? String(decrypted.motherPhone).trim().replace(/\D/g, '') : '';
                            const fatherPhone = decrypted.fatherPhone ? String(decrypted.fatherPhone).trim().replace(/\D/g, '') : '';
                            const personalPhone = decrypted.childPhone ? String(decrypted.childPhone).trim().replace(/\D/g, '') : '';

                            const matchesPhone = cleanPhone &&
                                ((legacyPhone && legacyPhone.includes(cleanPhone)) ||
                                (motherPhone && motherPhone.includes(cleanPhone)) ||
                                (fatherPhone && fatherPhone.includes(cleanPhone)) ||
                                (personalPhone && personalPhone.includes(cleanPhone)));

                            if (matchesId || matchesPhone) {
                                match = {
                                    id: decrypted.id || docSnap.id,
                                    name: decrypted.name,
                                    syncKey: childSyncKey,
                                    ...decrypted
                                };
                                break;
                            }
                        }
                    }
                }
            }

            if (match) {
                // 4. Save matching details to localStorage
                localStorage.setItem('parentChildId', match.id);
                localStorage.setItem('parentChildName', match.name);
                localStorage.setItem('parentSyncKey', match.syncKey);
                localStorage.setItem('parentClassName', selectedClass);

                // 5. Save FULL child record locally to Dexie for offline dashboards
                await db.children.put({
                    ...match,
                    id: String(match.id),
                    name: match.name,
                    syncKey: match.syncKey,
                    className: selectedClass,
                    isDirty: false,
                    isDeleted: false
                });

                // 6. Fetch child's attendance from Firestore and save locally
                try {
                    const attendanceSnapshot = await getDocs(collection(firestore, 'Osras', match.syncKey, 'attendance'));
                    const localAttendanceRecords = [];
                    attendanceSnapshot.forEach(docSnap => {
                        const data = docSnap.data();
                        if (data && data.payload) {
                            const record = decryptData(data.payload);
                            if (record && String(record.childId) === String(match.id)) {
                                localAttendanceRecords.push({ ...record, id: docSnap.id, syncKey: match.syncKey, isDirty: false, isDeleted: false });
                            }
                        } else if (data) {
                            if (String(data.childId) === String(match.id)) {
                                localAttendanceRecords.push({ ...data, id: docSnap.id, syncKey: match.syncKey, isDirty: false, isDeleted: false });
                            }
                        }
                    });
                    if (localAttendanceRecords.length > 0) {
                        await db.attendance.bulkPut(localAttendanceRecords);
                    }
                } catch (attErr) {
                    console.error("Error fetching child attendance:", attErr);
                }

                // 7. Fetch child's exam grades from Firestore and save locally
                try {
                    const examsSnapshot = await getDocs(collection(firestore, 'Osras', match.syncKey, 'exams'));
                    for (const examDoc of examsSnapshot.docs) {
                        try {
                            const gradeSnap = await getDoc(doc(firestore, 'Osras', match.syncKey, 'exams', examDoc.id, 'grades', String(match.id)));
                            if (gradeSnap.exists()) {
                                const gData = gradeSnap.data();
                                const decryptedGrade = gData.payload ? decryptData(gData.payload) : gData;
                                if (decryptedGrade) {
                                    await db.grades.put({
                                        childId: String(match.id),
                                        examId: examDoc.id,
                                        examName: decryptedGrade.examName || examDoc.data()?.examName || 'امتحان',
                                        maxGrade: decryptedGrade.maxGrade || examDoc.data()?.maxGrade || 100,
                                        grade: decryptedGrade.grade,
                                        date: decryptedGrade.date || examDoc.data()?.date || '',
                                        syncKey: match.syncKey,
                                        isDirty: false
                                    });
                                }
                            }
                        } catch (_) {}
                    }
                } catch (grdErr) {
                    console.error("Error fetching child grades:", grdErr);
                }

                // Redirect to parent dashboard
                navigate('/parent-dashboard');
            } else {
                setErrorMsg('لم يتم العثور على مخدوم مسجل بهذا الكود أو الرقم في هذا الفصل.');
            }
        } catch (error) {
            console.error(error);
            setErrorMsg('حدث خطأ أثناء الاتصال بالسيرفر. حاول مرة أخرى.');
        }

        setIsLoading(false);
    };

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans" dir="rtl">
            <div className="bg-white p-8 rounded-[2.5rem] shadow-2xl border border-slate-100 max-w-sm w-full relative overflow-hidden">
                <div className="absolute top-0 right-0 w-full h-2 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
                
                <div className="text-center mb-8">
                    <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 border border-blue-100 shadow-sm">
                        <User size={36} strokeWidth={1.5} />
                    </div>
                    <h2 className="text-2xl font-black text-slate-800">دخول أولياء الأمور</h2>
                    <p className="text-sm font-bold text-slate-500 mt-2">تابع حضور وتقييمات مخدومك بسهولة</p>
                </div>

                {errorMsg && (
                    <div className="bg-red-50 text-red-600 p-3 rounded-xl text-sm font-bold mb-4 flex items-center gap-2 border border-red-100">
                        <ShieldAlert size={16} /> {errorMsg}
                    </div>
                )}

                <form onSubmit={handleLogin} className="space-y-5">
                    <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-600 ml-1">اختر الفصل *</label>
                        <select 
                            value={selectedClass} 
                            onChange={(e) => setSelectedClass(e.target.value)}
                            className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            required
                        >
                            <option value="" disabled>-- اختر الفصل --</option>
                            {classes.map((c, i) => (
                                <option key={i} value={c.name || ''}>{c.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-600 ml-1">كود المخدوم أو رقم التليفون المسجل *</label>
                        <div className="relative">
                            <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                            <input 
                                type="text" 
                                value={phoneNumber}
                                onChange={(e) => setPhoneNumber(e.target.value)}
                                placeholder="مثال: 2026-B-0012 أو 01xxxxxxxxx"
                                className="w-full pl-10 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                required
                            />
                        </div>
                    </div>

                    <button 
                        type="submit" 
                        disabled={isLoading}
                        className="w-full bg-blue-600 text-white py-4 rounded-2xl font-black text-lg shadow-lg shadow-blue-500/30 hover:bg-blue-700 active:scale-95 transition-all flex justify-center items-center gap-2"
                    >
                        {isLoading ? <Loader2 className="animate-spin" size={24} /> : <><LogIn size={20} /> دخول للوحة المتابعة</>}
                    </button>
                </form>

                <div className="mt-6 text-center">
                    <button onClick={() => navigate('/login')} className="text-xs font-bold text-slate-400 hover:text-slate-600 underline">
                        هل أنت خادم؟ الدخول من هنا
                    </button>
                </div>
            </div>
        </div>
    );
}
