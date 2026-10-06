'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import { MapPin, Calendar } from 'lucide-react';

import { generateEnhancedFingerprint, isValidFingerprint } from '@/utils/clientFingerprint';
import { detectInAppBrowser, browserSummary } from '@/utils/browserInfo';
import { scanQrFromPhoto } from '@/utils/qrPhoto';
import {
  PlaceCode,
  QrPayload,
  buildQrPayload,
  parseQrPayload,
  isLegacyQr,
  signingMessage,
  signatureFromDigest
} from '@/utils/qrFormat';
import FullscreenQrScanner from '@/components/FullscreenQrScanner';
import QrProjector from '@/components/QrProjector';

const QR_VALIDITY_MS = 15 * 60 * 1000; // 15 dakika
// QR ekranı açıkken, süresinin dolmasına bu kadar kala yeni QR üretilir
const QR_RENEW_BEFORE_MS = 60 * 1000;
// Telefon saati ile öğretmen bilgisayarının saati arasındaki küçük farklar için tolerans
const QR_CLOCK_TOLERANCE_MS = 2 * 60 * 1000;
const MAX_SUBMIT_ATTEMPTS = 5;
const SUBMIT_TIMEOUT_MS = 55000;
const MAX_WEEK = 16;

interface ScannedQr {
  raw: string;        // sunucuya olduğu gibi gönderilir (imza sunucuda doğrulanır)
  payload: QrPayload;
}

interface AttendanceResponse {
  success?: boolean;
  error?: string;
  isAlreadyAttended?: boolean;
  blockedStudentId?: string;
  retryable?: boolean;
  locationError?: boolean;
}

interface WeekSuggestion {
  suggestedWeek: number;
  lastWeek: number | null;
  lastDate: string | null;
}

interface PlaceOption {
  code: PlaceCode;
  name: string;
}

interface Student {
  studentId: string;
  studentName: string;
}

interface StudentLocation {
  lat: number;
  lng: number;
  accuracy: number;
}

// QR imzası: öğretmen şifresiyle HMAC-SHA256 (sunucu aynı şekilde doğrular)
async function signQr(password: string, week: number, expiresAtSec: number, place: PlaceCode): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(signingMessage(week, expiresAtSec, place)));
  return signatureFromDigest(new Uint8Array(digest));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const parseJsonSafe = <T,>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // gizli sekme vb. - önemli değil
  }
};

// Modal Component'leri - Component dışında tanımlandı
const PasswordModal: React.FC<{
  password: string;
  setPassword: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}> = ({ password, setPassword, onSubmit, onClose }) => (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[100]">
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="bg-white rounded-xl p-6 w-full max-w-md space-y-4"
    >
      <h3 className="text-xl font-bold">Öğretmen Girişi</h3>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Şifre"
        className="w-full p-3 border rounded-lg"
        autoFocus
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 p-3 bg-gray-500 text-white rounded-lg"
        >
          İptal
        </button>
        <button
          type="submit"
          className="flex-1 p-3 bg-blue-600 text-white rounded-lg"
        >
          Giriş
        </button>
      </div>
    </form>
  </div>
);

const AttendanceSystem = () => {
  const [mode, setMode] = useState<'teacher' | 'student'>('student');
  const [showPasswordModal, setShowPasswordModal] = useState<boolean>(false);
  const [password, setPassword] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Öğretmen
  const [selectedWeek, setSelectedWeek] = useState<number>(1);
  // Öğretmen haftayı elle değiştirdiyse öneri onun seçimini ezmesin
  const weekTouchedRef = useRef<boolean>(false);
  const [weekSuggestion, setWeekSuggestion] = useState<WeekSuggestion | null>(null);
  const [places, setPlaces] = useState<PlaceOption[]>([{ code: 'O', name: 'Okul' }]);
  const [selectedPlace, setSelectedPlace] = useState<PlaceCode>('O');
  const [qrImageSrc, setQrImageSrc] = useState<string>('');
  const [qrValidUntil, setQrValidUntil] = useState<number>(0);
  const [showProjector, setShowProjector] = useState<boolean>(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [showDebugConsole, setShowDebugConsole] = useState<boolean>(false);
  const debugConsoleRef = useRef<HTMLDivElement>(null);
  const qrSettingsRef = useRef<{ week: number; place: PlaceCode }>({ week: 1, place: 'O' });
  // Sunucuda doğrulanan öğretmen şifresi: QR imzası ve öğretmene özel istekler için
  // yalnızca bellekte tutulur (sayfa yenilenince yeniden giriş gerekir)
  const teacherPasswordRef = useRef<string>('');
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  const teacherHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${teacherPasswordRef.current}`
  });

  // Öğrenci
  const [studentId, setStudentId] = useState<string>('');
  const [validStudents, setValidStudents] = useState<Student[]>([]);
  const [location, setLocation] = useState<StudentLocation | null>(null);
  const [isCheckingLocation, setIsCheckingLocation] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [pendingQr, setPendingQr] = useState<ScannedQr | null>(null);
  const [inAppBrowser, setInAppBrowser] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const updateDebugLogs = async (newLog: string) => {
    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log: newLog })
      });
    } catch (error) {
      console.error('Log gönderme hatası:', error);
    }
  };

  // ---------------------------------------------------------------------------
  // Öğretmen
  // ---------------------------------------------------------------------------

  const resetDeviceRecords = async () => {
    const confirmed = window.confirm(
      'Cihaz kayıtları sıfırlansın mı?\n\n' +
      'Bugün yoklama verilmiş telefonlar başka öğrenciler için tekrar kullanılabilir hale gelir. ' +
      'Eski biçimdeki uzun hücreler de sadece "VAR" olarak sadeleştirilir (tarih/saat Yoklama Kayıtları sayfasına aktarılır).'
    );
    if (!confirmed) return;

    setIsLoading(true);
    setStatus('⏳ Cihaz kayıtları sıfırlanıyor...');
    try {
      const response = await fetch('/api/attendance', { method: 'DELETE', headers: teacherHeaders() });
      const data = parseJsonSafe<{ message?: string; error?: string }>(await response.text());
      if (response.ok) {
        setStatus(`✅ ${data?.message || 'Cihaz kayıtları sıfırlandı'}`);
        updateDebugLogs(`🔄 ${data?.message || 'Cihaz kayıtları sıfırlandı'}`);
      } else {
        setStatus(`❌ ${data?.error || 'Cihaz kayıtları sıfırlanamadı'}`);
      }
    } catch {
      setStatus('❌ Bağlantı hatası, cihaz kayıtları sıfırlanamadı');
    } finally {
      setIsLoading(false);
    }
  };

  // Öğretmen paneline girince önerilen haftayı ve konum seçeneklerini yükle
  useEffect(() => {
    if (mode !== 'teacher') return;

    const savedPlace = readStorage('teacherPlace');

    fetch('/api/location')
      .then(response => response.json())
      .then((data: { places?: PlaceOption[] }) => {
        if (!data.places?.length) return;
        setPlaces(data.places);
        if (savedPlace && data.places.some(place => place.code === savedPlace)) {
          setSelectedPlace(savedPlace as PlaceCode);
        }
      })
      .catch(() => undefined);

    fetch('/api/week-suggestion')
      .then(response => (response.ok ? response.json() : null))
      .then((data: WeekSuggestion | null) => {
        if (!data || !Number.isInteger(data.suggestedWeek)) return;
        setWeekSuggestion(data);
        if (!weekTouchedRef.current) setSelectedWeek(data.suggestedWeek);
      })
      .catch(() => undefined);
  }, [mode]);

  const createQr = useCallback(async (week: number, place: PlaceCode) => {
    const validUntil = Date.now() + QR_VALIDITY_MS;
    const expiresAtSec = Math.floor(validUntil / 1000);
    const signature = await signQr(teacherPasswordRef.current, week, expiresAtSec, place);
    const svg = await QRCode.toString(buildQrPayload({ week, expiresAtSec, place, signature }), {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2
    });
    qrSettingsRef.current = { week, place };
    setQrImageSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    setQrValidUntil(validUntil);
  }, []);

  const generateQR = async () => {
    // Tarayıcı çubuklarını da gizlemek için tam ekran iste (tıklama anında istenmeli)
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    try {
      await createQr(selectedWeek, selectedPlace);
      setShowProjector(true);
      setStatus('');
      const placeName = places.find(place => place.code === selectedPlace)?.name || selectedPlace;
      updateDebugLogs(`🔳 Hafta ${selectedWeek} için QR oluşturuldu (konum: ${placeName})`);
    } catch (error) {
      console.error('QR oluşturma hatası:', error);
      setStatus('❌ QR kod oluşturulamadı');
    }
  };

  const closeProjector = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => undefined);
    }
    setShowProjector(false);
  }, []);

  // QR ekranı açık kaldığı sürece QR'ın süresi dolmasın: bitmesine az kala yenile
  useEffect(() => {
    if (!showProjector) return;
    const interval = setInterval(() => {
      if (qrValidUntil - Date.now() < QR_RENEW_BEFORE_MS) {
        const { week, place } = qrSettingsRef.current;
        createQr(week, place).catch(error => console.error('QR yenileme hatası:', error));
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [showProjector, qrValidUntil, createQr]);

  // Loglar yalnızca debug konsolu açıkken çekilir
  useEffect(() => {
    let interval: NodeJS.Timeout;

    const fetchLogs = async () => {
      try {
        const response = await fetch('/api/logs', { headers: teacherHeaders() });
        if (response.ok) {
          const data = await response.json();
          if (data.logs && data.logs.length !== debugLogs.length) {
            setDebugLogs(data.logs);
          }
        }
      } catch (error) {
        console.error('Log alma hatası:', error);
      }
    };

    if (mode === 'teacher' && showDebugConsole) {
      fetchLogs();
      interval = setInterval(fetchLogs, 1000);
    }

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [mode, showDebugConsole, debugLogs.length]);

  // Yeni log geldiğinde konsolu en alta kaydır
  useEffect(() => {
    if (showDebugConsole && debugConsoleRef.current) {
      debugConsoleRef.current.scrollTop = debugConsoleRef.current.scrollHeight;
    }
  }, [showDebugConsole, debugLogs.length]);

  const handleModeChange = () => {
    if (mode === 'student') {
      setShowPasswordModal(true);
    } else {
      setMode('student');
      teacherPasswordRef.current = '';
    }
  };

  // Şifre sunucuda doğrulanır (artık tarayıcı kodunda yazılı değil).
  // Sheets işlemleri sunucuda servis hesabıyla yapıldığı için Google OAuth gerekmiyor.
  const handlePasswordSubmit = async () => {
    if (isLoggingIn) return;
    const enteredPassword = password;
    setPassword('');
    setIsLoggingIn(true);
    try {
      const response = await fetch('/api/teacher-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: enteredPassword })
      });
      const data = parseJsonSafe<{ error?: string }>(await response.text());
      if (response.ok) {
        teacherPasswordRef.current = enteredPassword;
        setMode('teacher');
        setShowPasswordModal(false);
        setStatus('');
        updateDebugLogs(`===== ÖĞRETMEN OTURUMU BAŞLADI =====`);
      } else {
        setStatus(`❌ ${data?.error || 'Giriş yapılamadı'}`);
      }
    } catch {
      setStatus('❌ Bağlantı hatası, giriş yapılamadı');
    } finally {
      setIsLoggingIn(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Öğrenci
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (mode !== 'student') return;

    setInAppBrowser(detectInAppBrowser(navigator.userAgent));

    // Öğrenci numarasını bir önceki yoklamadan hatırla
    const lastAttendanceCheck = readStorage('lastAttendanceCheck');
    const savedId = lastAttendanceCheck ? parseJsonSafe<{ studentId?: string }>(lastAttendanceCheck)?.studentId : null;
    if (savedId) setStudentId(current => current || savedId);

    const loadStudentList = async () => {
      try {
        const response = await fetch('/api/students');
        if (!response.ok) {
          throw new Error('Öğrenci listesi alınamadı');
        }
        const data = await response.json();
        setValidStudents(data.students || []);
      } catch (error) {
        console.error('Öğrenci listesi yükleme hatası:', error);
        setStatus('❌ Öğrenci listesi yüklenemedi. Sayfayı yenileyin.');
      }
    };

    loadStudentList();
  }, [mode]);

  const getLocation = () => {
    if (!navigator.geolocation) {
      setStatus('❌ Bu tarayıcı konum özelliğini desteklemiyor');
      return;
    }

    setIsCheckingLocation(true);
    setStatus('📍 Konum alınıyor...');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const currentLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy
        };
        try {
          // Okula uzaklık sunucuda hesaplanır. Asıl kontrol yoklama kaydında,
          // QR'daki konuma (okul/ev) göre sunucuda yapılır; burası öğrenciye ön bilgidir.
          const response = await fetch('/api/check-location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: currentLocation.lat, lng: currentLocation.lng })
          });
          const data = parseJsonSafe<{ atSchool?: boolean; distanceToSchoolM?: number }>(await response.text());
          if (!response.ok || !data) throw new Error('Konum kontrolü başarısız');

          setLocation(currentLocation);
          if (data.atSchool) {
            setStatus('✅ Konum doğrulandı');
          } else {
            setStatus(`⚠️ Okul konumunda görünmüyorsunuz (${data.distanceToSchoolM} metre uzakta). ` +
              'Sınıftaysanız konumunuz tam algılanamamış olabilir; tekrar deneyin veya QR\'ı okutun.');
          }
        } catch {
          setStatus('❌ Konum doğrulanamadı (bağlantı hatası). Tekrar deneyin.');
        } finally {
          setIsCheckingLocation(false);
        }
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setStatus('❌ Konum izni verilmedi. Tarayıcı ayarlarından konum izni verin.');
        } else if (error.code === error.TIMEOUT) {
          setStatus('❌ Konum alınamadı (zaman aşımı). Tekrar deneyin.');
        } else {
          setStatus(`❌ Konum hatası: ${error.message}`);
        }
        setIsCheckingLocation(false);
      },
      // Konum alınamazsa sonsuza kadar beklemesin; 1 dk içindeki konum yeniden kullanılabilir
      { timeout: 15000, maximumAge: 60000 }
    );
  };

  const handleStudentIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newId = e.target.value;
    setStudentId(newId);
    setPendingQr(null);

    if (!newId) {
      setStatus('');
      return;
    }

    if (validStudents.length === 0) {
      setStatus('⚠️ Öğrenci listesi henüz yüklenmedi');
      return;
    }

    const validStudent = validStudents.find(s => s.studentId === newId.trim());

    if (!validStudent) {
      setStatus('⚠️ Bu öğrenci numarası listede yok');
      return;
    }

    setStatus('✅ Öğrenci numarası doğrulandı');
  };

  // Yoklamayı sunucuya gönderir. Sunucu yoğunsa (zaman aşımı, 5xx, JSON
  // olmayan yanıt) öğrencinin bir şey yapmasına gerek kalmadan otomatik
  // tekrar dener. Aynı öğrenci için tekrar gönderim güvenlidir: sunucu
  // "zaten alınmış" yanıtı döner.
  const submitAttendance = async (qr: ScannedQr) => {
    const trimmedId = studentId.trim();
    const validStudent = validStudents.find(s => s.studentId === trimmedId);

    if (!validStudent) {
      setStatus('❌ Öğrenci numarası listede bulunamadı');
      return;
    }

    if (qr.payload.expiresAtSec * 1000 + QR_CLOCK_TOLERANCE_MS < Date.now()) {
      setPendingQr(null);
      setStatus('❌ QR kodun süresi dolmuş. Öğretmeninizden yeni QR isteyin.');
      updateDebugLogs(`❌ ${trimmedId}: QR süresi dolmuş`);
      return;
    }

    if (!location) {
      setStatus('❌ Önce konumunuzu doğrulayın');
      return;
    }

    setIsSubmitting(true);
    setPendingQr(null);
    setStatus('⏳ Yoklamanız gönderiliyor...');

    try {
      // Cihaz modeli imzası yalnızca şüpheli kayıtları işaretlemek için kullanılır;
      // alınamazsa yoklama engellenmez
      let hardwareSignature = 'unknown';
      try {
        const ids = await generateEnhancedFingerprint();
        if (isValidFingerprint(ids.fingerprint, ids.hardwareSignature)) {
          hardwareSignature = ids.hardwareSignature;
        }
      } catch {
        // önemli değil
      }

      for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

        try {
          const response = await fetch('/api/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: trimmedId,
              qr: qr.raw,
              lat: location.lat,
              lng: location.lng,
              accuracy: location.accuracy,
              hardwareSignature
            }),
            signal: controller.signal
          });

          // Sunucu zaman aşımı gibi durumlarda yanıt JSON olmayabilir
          // (Safari'deki "The string did not match the expected pattern" hatası)
          const data = parseJsonSafe<AttendanceResponse>(await response.text());

          if (response.ok && data?.success) {
            writeStorage('lastAttendanceCheck', JSON.stringify({
              studentId: trimmedId,
              timestamp: new Date().toISOString()
            }));

            if (data.isAlreadyAttended) {
              setStatus(`✅ Sn. ${validStudent.studentName}, bu hafta için yoklamanız zaten alınmış`);
              updateDebugLogs(`ℹ️ ${trimmedId} ${validStudent.studentName}: Hafta ${qr.payload.week} zaten alınmış`);
            } else {
              setStatus(`✅ Sn. ${validStudent.studentName}, yoklamanız başarıyla kaydedildi`);
              updateDebugLogs(`✅ ${trimmedId} ${validStudent.studentName}: Hafta ${qr.payload.week} kaydedildi` +
                (attempt > 1 ? ` (${attempt}. denemede)` : ''));
            }
            return;
          }

          const isRetryable = !data || data.retryable === true ||
            response.status >= 500 || response.status === 429 || response.status === 408;

          if (!isRetryable) {
            // Kesin hata (cihaz engeli, konum dışı, öğrenci bulunamadı vb.) - tekrar denemek anlamsız
            setStatus(`❌ ${data.error || 'Yoklama kaydedilemedi'}`);
            updateDebugLogs(`❌ ${trimmedId}: ${data.error || response.status}`);
            return;
          }
        } catch (error) {
          // Ağ hatası veya istemci zaman aşımı - tekrar denenebilir
          console.warn('Yoklama gönderme hatası:', error);
        } finally {
          clearTimeout(timeoutId);
        }

        if (attempt < MAX_SUBMIT_ATTEMPTS) {
          setStatus(`⏳ Sunucu yoğun, otomatik olarak tekrar deneniyor (${attempt + 1}/${MAX_SUBMIT_ATTEMPTS})... Lütfen bekleyin.`);
          await sleep(attempt * 2000 + Math.random() * 1500);
        }
      }

      // Tüm denemeler başarısız: QR'ı sakla, öğrenci yeniden okutmadan tekrar deneyebilsin
      setPendingQr(qr);
      setStatus('⚠️ Sunucu şu an çok yoğun. Birkaç saniye sonra "Tekrar Gönder" butonuna basın.');
      updateDebugLogs(`⚠️ ${trimmedId}: ${MAX_SUBMIT_ATTEMPTS} deneme başarısız`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Okunan QR metnini değerlendirir. true: tarama bitsin, false: yoklama QR'ı değil, devam et
  const processQrText = (text: string): boolean => {
    const payload = parseQrPayload(text);
    if (payload) {
      setIsScanning(false);
      void submitAttendance({ raw: text.trim(), payload });
      return true;
    }
    if (isLegacyQr(text)) {
      setIsScanning(false);
      setStatus('❌ Bu QR kod uygulamanın eski sürümüne ait. Öğretmeninizden sayfayı yenileyip yeni QR oluşturmasını isteyin.');
      return true;
    }
    return false;
  };

  const handleQrDecoded = (decodedText: string): boolean => processQrText(decodedText);

  // Kamera hatasının nedenini öğretmenin görebilmesi için kayda geçir
  const reportCameraError = (detail: string) => {
    const userAgent = navigator.userAgent;
    void fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: studentId.trim(),
        error: detail,
        browser: browserSummary(userAgent),
        inAppBrowser: !!detectInAppBrowser(userAgent)
      })
    }).catch(() => undefined);
    updateDebugLogs(`📷 ${studentId.trim()}: Kamera hatası - ${detail} (${browserSummary(userAgent)})`);
  };

  const handleCameraError = (message: string, detail: string) => {
    setIsScanning(false);
    setStatus(`❌ ${message}`);
    reportCameraError(detail);
  };

  // Telefonun kendi kamera uygulamasıyla fotoğraf çekip QR'ı fotoğraftan oku
  const openPhotoCapture = () => {
    setIsScanning(false);
    photoInputRef.current?.click();
  };

  const handlePhotoSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // aynı fotoğraf tekrar seçilebilsin
    if (!file) return;

    setStatus('⏳ Fotoğraftaki QR kod okunuyor...');
    try {
      const text = await scanQrFromPhoto(file);
      if (!processQrText(text)) {
        setStatus('❌ Fotoğraftaki QR yoklama kodu değil. Öğretmenin yansıttığı QR kodu çekin.');
      }
    } catch {
      setStatus('❌ Fotoğrafta QR kod bulunamadı. QR kodu ortalayıp daha yakından (gerekirse yakınlaştırarak) tekrar çekin.');
    }
  };

  const isKnownStudent = !!studentId.trim() &&
    validStudents.some(s => s.studentId === studentId.trim());
  const canScan = !!location && isKnownStudent && !isLoading && !isSubmitting;

  return (
    <div className="min-h-screen p-4 bg-gray-50">

      {/* Tam ekran katmanlar en üst seviyede: space-y-* kapsayıcısı içinde
          kalırlarsa margin-top alıp ekranın üstünde boşluk bırakıyorlar */}
      {mode === 'teacher' && showProjector && qrImageSrc && (
        <QrProjector qrImageSrc={qrImageSrc} onClose={closeProjector} />
      )}

      {mode === 'student' && isScanning && (
        <FullscreenQrScanner
          onDecoded={handleQrDecoded}
          onClose={() => setIsScanning(false)}
          onCameraError={handleCameraError}
          onUsePhoto={openPhotoCapture}
        />
      )}

      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handlePhotoSelected}
      />

      {showPasswordModal && (
        <PasswordModal
          password={password}
          setPassword={setPassword}
          onSubmit={handlePasswordSubmit}
          onClose={() => {
            setShowPasswordModal(false);
            setPassword('');
          }}
        />
      )}
      <div className="max-w-md mx-auto space-y-6">
        {status && (
          <div className={`p-4 rounded-lg ${
            status.startsWith('❌') ? 'bg-red-100 text-red-800' :
            status.startsWith('⚠️') ? 'bg-yellow-100 text-yellow-800' :
            status.startsWith('⏳') || status.startsWith('📍') ? 'bg-blue-100 text-blue-800' :
            'bg-green-100 text-green-800'}`}
            role="status"
            aria-live="polite"
          >
            {status}
          </div>
        )}

        {mode === 'teacher' ? (
          <div className="bg-white p-6 rounded-xl shadow-md space-y-4">
            <div className="flex items-center justify-center mb-6">
              <h2 className="text-xl font-bold text-gray-800 mr-2">Öğretmen Paneli</h2>
              <img
                src="/ytu-logo.png"
                alt="YTÜ Logo"
                className="w-14 h-14 object-contain ml-1"
              />
            </div>

            <div className="flex items-center gap-2">
              <Calendar size={24} className="text-blue-600" />
              <select
                value={selectedWeek}
                onChange={(e) => {
                  setSelectedWeek(Number(e.target.value));
                  weekTouchedRef.current = true;
                }}
                className="p-3 border-2 border-gray-300 rounded-lg flex-1 text-lg font-medium text-gray-700 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 appearance-none"
                disabled={isLoading}
                aria-label="Hafta"
              >
                {Array.from({ length: MAX_WEEK }, (_, i) => i + 1).map(week => (
                  <option key={week} value={week}>
                    Hafta {week}{weekSuggestion?.suggestedWeek === week ? ' (önerilen)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {weekSuggestion?.lastWeek && (
              <p className="text-xs text-gray-500 -mt-2">
                Son yoklama: Hafta {weekSuggestion.lastWeek}
                {weekSuggestion.lastDate ? ` (${weekSuggestion.lastDate})` : ''}
                {' · '}Önerilen: Hafta {weekSuggestion.suggestedWeek}
              </p>
            )}

            <div className="flex items-center gap-2">
              <MapPin size={20} className="text-gray-500" />
              <label htmlFor="place-select" className="text-sm text-gray-600">Konum:</label>
              <select
                id="place-select"
                value={selectedPlace}
                onChange={(e) => {
                  const place = e.target.value as PlaceCode;
                  setSelectedPlace(place);
                  writeStorage('teacherPlace', place);
                }}
                className={`p-1.5 border rounded-md text-sm ${
                  selectedPlace === 'O' ? 'border-gray-300 text-gray-700' : 'border-orange-400 text-orange-700 bg-orange-50'
                }`}
                disabled={isLoading}
              >
                {places.map(place => (
                  <option key={place.code} value={place.code}>{place.name}</option>
                ))}
              </select>
              {selectedPlace !== 'O' && (
                <span className="text-xs text-orange-600">Test modu</span>
              )}
            </div>

            <button
              onClick={generateQR}
              className="w-full p-3 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700 text-lg font-semibold"
              disabled={isLoading}
            >
              QR Oluştur
            </button>

            {qrImageSrc && !showProjector && qrValidUntil > Date.now() && (
              <button
                onClick={() => {
                  document.documentElement.requestFullscreen?.().catch(() => undefined);
                  setShowProjector(true);
                }}
                className="w-full p-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm"
              >
                Son QR&apos;ı tekrar göster (Hafta {qrSettingsRef.current.week})
              </button>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={resetDeviceRecords}
                className="p-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
                disabled={isLoading}
              >
                🔄 Cihaz Kayıtlarını Temizle
              </button>
            </div>

            <div className="border-t pt-4">
              <button
                onClick={() => setShowDebugConsole(!showDebugConsole)}
                className="w-full p-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm flex items-center justify-between"
                aria-expanded={showDebugConsole}
              >
                <span>🖥️ Debug Konsolu</span>
                <span>{showDebugConsole ? '▲ Gizle' : '▼ Göster'}</span>
              </button>

              {showDebugConsole && (
                <div
                  ref={debugConsoleRef}
                  className="mt-2 p-4 bg-black text-white rounded-lg text-xs font-mono overflow-auto max-h-60"
                >
                  {debugLogs.length === 0 ? (
                    <div className="text-gray-400">Henüz log yok</div>
                  ) : (
                    debugLogs.map((log, i) => (
                      <div key={i} className="whitespace-pre-wrap mb-1">{log}</div>
                    ))
                  )}
                </div>
              )}
            </div>

          </div>

        ) : (
          <>
            {inAppBrowser && (
              <div className="p-4 rounded-lg bg-yellow-100 text-yellow-900 text-sm">
                ⚠️ Bu sayfa {inAppBrowser} içinde açıldı. Kamera bu tarayıcıda çalışmayabilir.
                Sağ üstteki menüden <b>&quot;Tarayıcıda aç&quot;</b> (Safari/Chrome) seçeneğini kullanın.
              </div>
            )}

            <div className="bg-white p-6 rounded-xl shadow-md space-y-4">
              <div className="flex items-center justify-center mb-6">
                <h2 className="text-xl font-bold text-gray-800 mr-2">Öğrenci Yoklaması</h2>
                <img
                  src="/ytu-logo.png"
                  alt="YTÜ Logo"
                  className="w-14 h-14 object-contain ml-1"
                />
              </div>

              <div className="space-y-4">
                <input
                  value={studentId}
                  onChange={handleStudentIdChange}
                  placeholder="Öğrenci Numaranız"
                  autoComplete="off"
                  className={`w-full p-3 border-2 rounded-lg text-lg font-bold tracking-wider focus:ring-2 ${
                    studentId && !isKnownStudent
                      ? 'border-red-500 focus:ring-red-500 text-red-800'
                      : 'border-blue-400 focus:ring-blue-500 text-blue-900'
                  }`}
                  disabled={isLoading || isSubmitting}
                />

                {studentId && validStudents.length > 0 && (
                  <p className={`text-sm ${isKnownStudent ? 'text-green-600' : 'text-red-600'}`}>
                    {isKnownStudent
                      ? '✅ Öğrenci numarası doğrulandı'
                      : '❌ Öğrenci numarası listede bulunamadı'}
                  </p>
                )}

                {/* Not: Butonlar önceden herhangi bir ❌ mesajından sonra kilitleniyordu;
                    öğrenci tekrar deneyebilmek için numarasını yeniden yazmak zorunda kalıyordu */}
                <button
                  onClick={getLocation}
                  className="w-full p-3 bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isLoading || isSubmitting || isCheckingLocation || !isKnownStudent}
                >
                  <MapPin size={18} /> {isCheckingLocation ? 'Konum kontrol ediliyor...' : 'Konumu Doğrula'}
                </button>

                <button
                  onClick={() => setIsScanning(true)}
                  className="w-full p-4 bg-green-600 text-white rounded-lg text-lg font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!canScan}
                >
                  {isSubmitting ? '⏳ Gönderiliyor...' : '📷 QR Tara'}
                </button>

                {canScan && (
                  <button
                    onClick={openPhotoCapture}
                    className="w-full text-sm text-gray-600 underline"
                  >
                    Kamera açılmıyor mu? 📸 Fotoğraf çekerek okut
                  </button>
                )}

                {pendingQr && !isSubmitting && (
                  <button
                    onClick={() => void submitAttendance(pendingQr)}
                    className="w-full p-3 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 font-semibold"
                  >
                    🔄 Tekrar Gönder (QR&apos;ı yeniden okutmanız gerekmez)
                  </button>
                )}
              </div>
            </div>

            <button
              onClick={handleModeChange}
              className="w-full p-3 bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300 transition-colors mt-4"
              disabled={isLoading}
            >
              👨🏫 Öğretmen Moduna Geç
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default AttendanceSystem;
