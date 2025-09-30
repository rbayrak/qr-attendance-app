'use client';

import React, { useState, useEffect } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { MapPin, Calendar } from 'lucide-react';

import { STATIC_CLASS_LOCATION } from '../config/constants';
import { generateEnhancedFingerprint, isValidFingerprint } from '@/utils/clientFingerprint';

// TypeScript için window tanımlamaları
declare global {
  interface Window {
    google: any;
    gapi: any;
  }
}

// ✅ GÜVENLİK: Client-side'da artık env variables kullanmıyoruz
const MAX_DISTANCE = 0.8;

interface Student {
  studentId: string;
  studentName: string;
}

interface Location {
  lat: number;
  lng: number;
}

// Google Auth yardımcı fonksiyonları
let tokenClient: any;
let accessToken: string | null = null;

const initializeGoogleAuth = () => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Window objesi bulunamadı'));
      return;
    }
    
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      reject(new Error('Client ID bulunamadı. Lütfen env değerlerini kontrol edin.'));
      return;
    }

    console.log('🔐 Google Auth başlatılıyor...');
    console.log('📋 Client ID:', clientId.substring(0, 20) + '...');

    // Google Identity Services'in yüklenmesini bekle
    const checkGoogleLoaded = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(checkGoogleLoaded);
        
        try {
          console.log('✅ Google Identity Services yüklendi');
          
          tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            callback: (tokenResponse: any) => {
              if (tokenResponse.error) {
                console.error('❌ Token hatası:', tokenResponse);
                reject(new Error(`Token hatası: ${tokenResponse.error}`));
                return;
              }
              accessToken = tokenResponse.access_token;
              console.log('✅ Access token alındı');
              resolve(accessToken);
            },
            error_callback: (error: any) => {
              console.error('❌ OAuth hatası:', error);
              reject(new Error(`OAuth hatası: ${JSON.stringify(error)}`));
            }
          });

          console.log('🔄 Token isteniyor...');
          // Token'ı talep et
          setTimeout(() => {
            try {
              tokenClient.requestAccessToken({ 
                prompt: 'consent',
                // Hint ekleyelim
                hint: 'teacher'
              });
            } catch (error) {
              console.error('❌ Token talep hatası:', error);
              reject(error);
            }
          }, 500);

        } catch (error) {
          console.error('❌ Google Identity Services init hatası:', error);
          reject(error);
        }
      }
    }, 100);

    // 15 saniye sonra timeout
    setTimeout(() => {
      clearInterval(checkGoogleLoaded);
      if (!accessToken) {
        reject(new Error('Google Identity Services yüklenemedi (timeout). Lütfen sayfayı yenileyin.'));
      }
    }, 15000);
  });
};


const getAccessToken = async () => {
  if (!accessToken) {
    tokenClient.requestAccessToken();
    return new Promise((resolve) => {
      const checkToken = setInterval(() => {
        if (accessToken) {
          clearInterval(checkToken);
          resolve(accessToken);
        }
      }, 100);
    });
  }
  return accessToken;
};

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
};

// Modal Component'leri - Component dışında tanımlandı
const PasswordModal: React.FC<{
  password: string;
  setPassword: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}> = ({ password, setPassword, onSubmit, onClose }) => (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[100]">
    <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-4">
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
          onClick={onClose}
          className="flex-1 p-3 bg-gray-500 text-white rounded-lg"
        >
          İptal
        </button>
        <button
          onClick={onSubmit}
          className="flex-1 p-3 bg-blue-600 text-white rounded-lg"
        >
          Giriş
        </button>
      </div>
    </div>
  </div>
);

const FingerprintModal: React.FC<{
  fingerprint: string;
  setFingerprint: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}> = ({ fingerprint, setFingerprint, onSubmit, onClose }) => (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[200]">
    <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-4">
      <h3 className="text-xl font-bold">Fingerprint Silme</h3>
      <p className="text-sm text-gray-600 mb-2">
        Google Sheets&apos;te görünen DF:xxxx formatındaki fingerprint&apos;i girin.
        <br />
        Örnek: Eğer sheets&apos;te &quot;VAR (DF:123456)&quot; yazıyorsa, &quot;123456&quot; girin.
      </p>
      <input
        type="text"
        value={fingerprint}
        onChange={(e) => setFingerprint(e.target.value.trim())}
        placeholder="Fingerprint numarası"
        className="w-full p-3 border rounded-lg"
        autoFocus
      />
      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 p-3 bg-gray-500 text-white rounded-lg"
        >
          İptal
        </button>
        <button
          onClick={onSubmit}
          className="flex-1 p-3 bg-red-600 text-white rounded-lg"
        >
          Sil
        </button>
      </div>
    </div>
  </div>
);

const AttendanceSystem = () => {
  const [mode, setMode] = useState<'teacher' | 'student'>('student');
  const [showPasswordModal, setShowPasswordModal] = useState<boolean>(false);
  const [password, setPassword] = useState<string>('');
  const [isTeacherAuthenticated, setIsTeacherAuthenticated] = useState<boolean>(false);
  const [selectedWeek, setSelectedWeek] = useState<number>(1);
  const [qrData, setQrData] = useState<string>('');
  const [location, setLocation] = useState<Location | null>(null);
  const [studentId, setStudentId] = useState<string>('');
  const [attendance, setAttendance] = useState<Student[]>([]);
  const [status, setStatus] = useState<string>('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [html5QrCode, setHtml5QrCode] = useState<Html5Qrcode | null>(null);
  const [validStudents, setValidStudents] = useState<Student[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isValidLocation, setIsValidLocation] = useState<boolean>(false);
  const [classLocation, setClassLocation] = useState<Location | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [showFingerprintModal, setShowFingerprintModal] = useState<boolean>(false);
  const [fingerprintToDelete, setFingerprintToDelete] = useState<string>('');
  const [qrSubmitCount, setQrSubmitCount] = useState<number>(0);
  const [connectionError, setConnectionError] = useState<boolean>(false);
  const [queuePosition, setQueuePosition] = useState<number>(0); // Kuyruk pozisyonu

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

  const clearMemoryStore = async () => {
    try {
      setIsLoading(true);
      setStatus('🔄 Cihaz kayıtları temizleniyor...');
      updateDebugLogs(`🔄 Cihaz kayıtları temizleme işlemi başlatıldı`);
      
      try {
        // 1. Adım: Memory store ve StudentDevices sayfasını temizle
        const response1 = await fetch('/api/attendance?cleanStep=memory', {
          method: 'DELETE'
        });
        
        if (!response1.ok) {
          const errorText = await response1.text();
          setStatus('❌ Memory store temizlenemedi');
          updateDebugLogs(`❌ HATA: Memory store temizleme hatası: ${errorText}`);
          return;
        }

        setStatus('✅ Memory store ve cihaz eşleştirmeleri temizlendi, Google Sheets temizleniyor...');
        updateDebugLogs(`✅ Memory store ve StudentDevices temizlendi, Google Sheets işlemi başlatılıyor...`);
        
        const jobId = `sheets-cleanup-${Date.now()}`;
        
        // 2. Adım: Job başlat (ÖNEMLİ: action=start)
        const startResponse = await fetch(`/api/job-status?action=start&jobId=${jobId}&week=${selectedWeek}`);
        
        if (!startResponse.ok) {
          const errorText = await startResponse.text();
          throw new Error(`Job başlatılamadı: ${errorText}`);
        }
        
        const startData = await startResponse.json();
        updateDebugLogs(`✅ Job başlatıldı: ${startData.totalCells} hücre temizlenecek`);
        
        // 3. Adım: Batch işlemleri
        let isCompleted = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 30;
        
        while (!isCompleted && attempts < MAX_ATTEMPTS) {
          attempts++;
          
          try {
            const processResponse = await fetch(`/api/job-status?action=process&jobId=${jobId}&week=${selectedWeek}`);
            
            if (!processResponse.ok) {
              const errorText = await processResponse.text();
              throw new Error(`İşlem hatası: ${errorText}`);
            }
            
            const processData = await processResponse.json();
            isCompleted = processData.completed;
            
            const progress = processData.progress || 0;
            const processedCells = processData.processedCells || 0;
            const totalCells = processData.totalCells || 0;
            
            setStatus(`⏳ Temizleme sürüyor... (${progress}% - ${processedCells}/${totalCells})`);
            updateDebugLogs(`📊 İlerleme: ${progress}% (${processedCells}/${totalCells})`);
            
            // Tamamlandıysa döngüden çık
            if (isCompleted) {
              break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1500));
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Bilinmeyen hata';
            updateDebugLogs(`⚠️ UYARI: Batch işleme hatası (${attempts}. deneme): ${errorMessage}`);
            
            // Hata durumunda 3 saniye bekle
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            if (attempts >= MAX_ATTEMPTS) {
              throw new Error(`Maksimum deneme sayısına ulaşıldı (${MAX_ATTEMPTS}): ${errorMessage}`);
            }
          }
        }
        
        if (isCompleted) {
          setStatus('✅ Tüm cihaz kayıtları başarıyla temizlendi');
          updateDebugLogs(`✅ Google Sheets kayıtları tamamen temizlendi`);
          setTimeout(() => setStatus(''), 5000);
        } else {
          setStatus('⚠️ Temizleme işlemi yarım kaldı, daha sonra tekrar deneyiniz');
          updateDebugLogs(`⚠️ UYARI: Maksimum deneme sayısına ulaşıldı, işlem yarım kaldı`);
        }
      } catch (error: any) {
        const errorMessage = error.message || 'Bilinmeyen hata';
        setStatus(`❌ Hata: ${errorMessage}`);
        updateDebugLogs(`❌ HATA: ${errorMessage}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const deleteFingerprint = async () => {
    try {
      setIsLoading(true);
      updateDebugLogs(`🔄 Fingerprint silme işlemi başlatıldı: ${fingerprintToDelete}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 saniye (60 kişilik sınıf için)
      
      try {
        const response = await fetch(`/api/attendance?fingerprint=${fingerprintToDelete}`, {
          method: 'DELETE',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        let data;
        try {
          data = await response.json();
        } catch (parseError) {
          throw new Error('API yanıtı JSON değil');
        }
        
        if (response.ok) {
          setStatus('✅ Fingerprint başarıyla silindi');
          updateDebugLogs(`✅ Fingerprint memory ve sheets'ten silindi: ${fingerprintToDelete}`);
          setTimeout(() => setStatus(''), 3000);
        } else {
          setStatus(`❌ ${data.error || 'Fingerprint silinemedi'}`);
          updateDebugLogs(`❌ HATA: ${data.error}`);
        }
      } catch (fetchError: any) {
        if (fetchError.name === 'AbortError') {
          setStatus('⚠️ İşlem zaman aşımına uğradı');
          updateDebugLogs(`⚠️ TIMEOUT: Fingerprint silme işlemi zaman aşımına uğradı`);
        } else {
          const errorMessage = fetchError.message || 'Bilinmeyen hata';
          setStatus(`❌ Hata: ${errorMessage}`);
          updateDebugLogs(`❌ HATA: ${errorMessage}`);
        }
      }
    } finally {
      setIsLoading(false);
      setShowFingerprintModal(false);
      setFingerprintToDelete('');
    }
  };

  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    const fetchLogs = async () => {
      try {
        const response = await fetch('/api/logs');
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
  
    if (mode === 'teacher') {
      fetchLogs();
      interval = setInterval(fetchLogs, 1000);
    }
  
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [mode, debugLogs.length]);

  useEffect(() => {
    if (mode === 'student') {
      const lastAttendanceCheck = localStorage.getItem('lastAttendanceCheck');
      if (lastAttendanceCheck) {
        const checkData = JSON.parse(lastAttendanceCheck);
        
        setStudentId(checkData.studentId);
        
        if (validStudents.length > 0) {
          const isValid = validStudents.some(s => s.studentId === checkData.studentId);
          if (isValid) {
            const now = new Date();
            const checkTime = new Date(checkData.timestamp);
            
            if (now.toDateString() === checkTime.toDateString()) {
              setStatus('✅ Öğrenci numarası doğrulandı');
              setIsValidLocation(true);
            }
          }
        }
      }
    }
  }, [mode, validStudents]);

  
  const getClientIP = async () => {
    try {
      const response = await fetch('https://api.ipify.org?format=json');
      const data = await response.json();
      
      const { fingerprint, hardwareSignature } = await generateEnhancedFingerprint();
      
      if (!isValidFingerprint(fingerprint, hardwareSignature)) {
        throw new Error('Geçersiz cihaz tanımlama');
      }
      
      return {
        ip: data.ip,
        deviceFingerprint: fingerprint,
        hardwareSignature
      };
    } catch (error) {
      console.error('IP/Fingerprint alınamadı:', error);
      throw new Error('Cihaz tanımlama başarısız');
    }
  };
  

  const handleModeChange = () => {
    if (mode === 'student') {
      setShowPasswordModal(true);
    } else {
      setMode('student');
      setIsTeacherAuthenticated(false);
      const savedClassLocation = localStorage.getItem('classLocation');
      if (savedClassLocation) {
        setClassLocation(JSON.parse(savedClassLocation));
      }
    }
  };

  
  
  const handlePasswordSubmit = () => {
    if (password === 'teacher123') {
      setIsTeacherAuthenticated(true);
      setMode('teacher');
      setShowPasswordModal(false);
      
      const savedLogs = localStorage.getItem('debugLogs');
      if (savedLogs) {
        setDebugLogs(JSON.parse(savedLogs));
      }
  
      updateDebugLogs(`===== ÖĞRETMEN OTURUMU BAŞLADI =====`);
  
      const savedClassLocation = localStorage.getItem('classLocation');
      if (savedClassLocation) {
        setClassLocation(JSON.parse(savedClassLocation));
      }
      
      // Google Auth'u başlat
      console.log('🔄 Google yetkilendirme başlatılıyor...');
      initializeGoogleAuth().then(() => {
        console.log('✅ Google yetkilendirme tamamlandı');
        setIsAuthenticated(true);
        fetchStudentList();
      }).catch(error => {
        const errorMessage = error instanceof Error ? error.message : 'Bilinmeyen hata';
        console.error('❌ Google yetkilendirme hatası:', errorMessage);
        updateDebugLogs(`❌ HATA: Google yetkilendirme hatası - ${errorMessage}`);
        setStatus(`❌ Google yetkilendirme hatası: ${errorMessage}`);
      });
    } else {
      setStatus('❌ Yanlış şifre');
    }
    setPassword('');
  };


  useEffect(() => {
    const loadStudentList = async () => {
      try {
        if (mode === 'student') {
          const response = await fetch('/api/students');
          
          if (!response.ok) {
            throw new Error('Öğrenci listesi alınamadı');
          }
          
          const data = await response.json();
          setValidStudents(data.students || []);
        }
      } catch (error) {
        console.error('Öğrenci listesi yükleme hatası:', error);
        setStatus('❌ Öğrenci listesi yüklenemedi');
      }
    };

    loadStudentList();
  }, [mode]);

  const fetchStudentList = async () => {
    try {
      const response = await fetch('/api/students');
      
      if (!response.ok) {
        throw new Error('Öğrenci listesi alınamadı');
      }
      
      const data = await response.json();
      setValidStudents(data.students || []);
    } catch (error) {
      console.error('Öğrenci listesi çekme hatası:', error);
      setStatus('❌ Öğrenci listesi yüklenemedi');
    }
  };

  const updateAttendance = async (studentId: string) => {
    console.warn('updateAttendance deprecated - backend kullanılıyor');
    return false;
  };
  
  const getLocation = async () => {
    if (!navigator.geolocation) {
      setStatus('❌ Konum desteği yok');
      return;
    }
  
    setStatus('📍 Konum alınıyor...');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const currentLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        setLocation(currentLocation);
  
        try {
          const distance = calculateDistance(
            currentLocation.lat,
            currentLocation.lng,
            STATIC_CLASS_LOCATION.lat,
            STATIC_CLASS_LOCATION.lng
          );
  
          if (distance > MAX_DISTANCE) {
            setIsValidLocation(false);
            setStatus(`❌ Sınıf konumunda değilsiniz (${(distance * 1000).toFixed(0)} metre uzaktasınız)`);
          } else {
            setIsValidLocation(true);
            setStatus('✅ Konum doğrulandı');
          }
        } catch (error) {
          setStatus('❌ Konum kontrolü yapılamadı');
        }
      },
      (error) => {
        setStatus(`❌ Konum hatası: ${error.message}`);
        setIsValidLocation(false);
      }
    );
  };

  const generateQR = async () => {
    try {
      await fetch('/api/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(STATIC_CLASS_LOCATION)
      });
      
      const payload = {
        timestamp: Date.now(),
        classLocation: STATIC_CLASS_LOCATION,
        validUntil: Date.now() + 900000,
        week: selectedWeek
      };
      
      setQrData(JSON.stringify(payload));
      setStatus('✅ QR kod oluşturuldu');
    } catch (error) {
      setStatus('❌ QR kod oluşturulamadı');
    }
  };

  const handleStudentIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newId = e.target.value;
    setStudentId(newId);
    
    setIsValidLocation(false);
    
    if (!newId) {
      setStatus('');
      return;
    }
    
    if (validStudents.length === 0) {
      setStatus('⚠️ Öğrenci listesi henüz yüklenmedi');
      return;
    }
    
    const validStudent = validStudents.find(s => s.studentId === newId);
    
    if (!validStudent) {
      setStatus('⚠️ Bu öğrenci numarası listede yok');
      return;
    }
    
    setStatus('✅ Öğrenci numarası doğrulandı');
  };

  const handleQrScan = async (decodedText: string) => {
    const lastScanTime = localStorage.getItem('lastQrScanTime');
    const currentTime = Date.now();
    
    if (lastScanTime && currentTime - parseInt(lastScanTime) < 3000) {
      return;
    }
    
    localStorage.setItem('lastQrScanTime', currentTime.toString());

    const newCount = qrSubmitCount + 1;
    setQrSubmitCount(newCount);
    if (newCount > 0) {
      setStatus('🔄 İşlem sürüyor... Yoğun saatlerde bekleme süresi uzayabilir.');
    }

    try {
      const scannedData = JSON.parse(decodedText);
      const currentTimeString = new Date().toLocaleTimeString();
      const studentInfo = validStudents.find(s => s.studentId === studentId);

      const scanLog = `
      ===== YENİ YOKLAMA KAYDI =====
      Zaman: ${currentTimeString}
      Öğrenci: ${studentInfo?.studentName || 'Bilinmiyor'} (${studentId})
      Hafta: ${scannedData.week}
      `;
      updateDebugLogs(scanLog);

      const validStudent = validStudents.find(s => s.studentId === studentId);
      if (!validStudent) {
        const errorLog = `❌ HATA: Öğrenci numarası (${studentId}) listede bulunamadı`;
        updateDebugLogs(errorLog);
        setStatus('❌ Öğrenci numarası listede bulunamadı');
        return;
      }

      if (scannedData.validUntil < Date.now()) {
        updateDebugLogs(`❌ HATA: QR kod süresi dolmuş`);
        setStatus('❌ QR kod süresi dolmuş');
        return;
      }

      if (!location) {
        updateDebugLogs(`❌ HATA: Konum bilgisi yok`);
        setStatus('❌ Önce konum alın');
        return;
      }

      const clientIPData = await getClientIP();
      if (!clientIPData || !clientIPData.deviceFingerprint || !clientIPData.hardwareSignature) {
        updateDebugLogs(`❌ HATA: Cihaz tanımlama başarısız`);
        setStatus('❌ Cihaz tanımlama hatası. Lütfen tekrar deneyin.');
        return;
      }

      const { ip, deviceFingerprint, hardwareSignature } = clientIPData;

      const locationLog = `
      📍 KONUM BİLGİLERİ:
      Öğrenci Konumu: ${location.lat}, ${location.lng}
      Sınıf Konumu: ${scannedData.classLocation.lat}, ${scannedData.classLocation.lng}
      Konum Durumu: ${isValidLocation ? '✅ Geçerli' : '❌ Geçersiz'}

      📱 CİHAZ BİLGİLERİ:
      IP: ${ip}
      Fingerprint: ${deviceFingerprint.slice(0, 8)}...
      Hardware ID: ${hardwareSignature.slice(0, 8)}...
      `;
      updateDebugLogs(locationLog);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 saniye (60 kişilik sınıf için)
      
      try {
        const attendanceResponse = await fetch('/api/attendance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId,
            week: scannedData.week,
            clientIP: ip,
            deviceFingerprint,
            hardwareSignature
          }),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        setConnectionError(false);

        const responseData = await attendanceResponse.json();

        if (!attendanceResponse.ok) {
          if (responseData.unauthorizedDevice) {
            updateDebugLogs(`❌ HATA: Bu cihaz bu öğrenciye ait değil`);
            setStatus(`❌ Bu cihaz ${studentId} numaralı öğrenciye ait değil. Kendi cihazınızı kullanmalısınız!`);
            setIsScanning(false);
            if (html5QrCode) {
              await html5QrCode.stop();
            }
            return;
          }
          
          if (responseData.blockedStudentId) {
            updateDebugLogs(`❌ HATA: Cihaz ${responseData.blockedStudentId} no'lu öğrenci tarafından kullanılmış`);
            setStatus(`❌ Bu cihaz bugün ${responseData.blockedStudentId} numaralı öğrenci için kullanılmış`);
            setIsScanning(false);
            if (html5QrCode) {
              await html5QrCode.stop();
            }
            return;
          }
          
          throw new Error(responseData.error || 'Yoklama kaydedilemedi');
        }

        localStorage.setItem('lastAttendanceCheck', JSON.stringify({
          studentId: studentId,
          timestamp: new Date().toISOString()
        }));

        if (responseData.isAlreadyAttended) {
          updateDebugLogs(`⚠️ UYARI: ${studentId} no'lu öğrenci için yoklama zaten alınmış`);
          setStatus(`✅ Sn. ${validStudent.studentName}, bu hafta için yoklamanız zaten alınmış`);
        } else {
          updateDebugLogs(`✅ BAŞARILI: ${studentId} no'lu öğrenci için yoklama kaydedildi`);
          setStatus(`✅ Sn. ${validStudent.studentName}, yoklamanız başarıyla kaydedildi`);
        }

      } catch (fetchError: any) {
        if (fetchError.name === 'AbortError') {
          updateDebugLogs(`⚠️ API TIMEOUT: İstek zaman aşımına uğradı (60 saniye)`);
          setStatus('⚠️ Sunucu yoğun, lütfen biraz sonra tekrar deneyin (60sn timeout)');
          setConnectionError(true);
          return;
        }
        
        if (fetchError instanceof TypeError && fetchError.message.includes('fetch')) {
          updateDebugLogs(`❌ NETWORK HATASI: Sunucuya bağlanılamadı`);
          setStatus('❌ Bağlantı hatası, internet bağlantınızı kontrol edin');
          setConnectionError(true);
          return;
        }
        
        throw fetchError;
      }

    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Bilinmeyen hata';
      
      if (errorMessage.includes('fingerprint') || 
          errorMessage.includes('tanımlama') || 
          errorMessage.includes('hardware')) {
        updateDebugLogs(`❌ CİHAZ TANIMA HATASI: ${errorMessage}`);
        setStatus('❌ Cihaz tanımlama hatası. Lütfen öğretmeninize başvurun.');
      } else {
        updateDebugLogs(`❌ GENEL HATA: ${errorMessage}`);
        setStatus(`❌ ${errorMessage}`);
      }
    } finally {
      setQrSubmitCount(0);
      
      if (!connectionError) {
        setIsScanning(false);
        if (html5QrCode) {
          await html5QrCode.stop();
        }
      }
    }
  };

  useEffect(() => {
    let scanner: Html5Qrcode;
    
    const initializeScanner = async () => {
      if (isScanning) {
        try {
          scanner = new Html5Qrcode("qr-reader");
          await scanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: 250 },
            handleQrScan,
            () => {}
          );
          setHtml5QrCode(scanner);
        } catch (error) {
          setStatus('❌ Kamera başlatılamadı');
          setIsScanning(false);
        }
      }
    };

    initializeScanner();
    return () => {
      if (scanner) scanner.stop().catch(() => {});
    };
  }, [isScanning]);

  const clearAllRecords = async () => {
    try {
      const deviceResponse = await fetch('/api/attendance', {
        method: 'DELETE'
      });
  
      const logsResponse = await fetch('/api/logs', {
        method: 'DELETE'
      });
  
      if (deviceResponse.ok && logsResponse.ok) {
        setDebugLogs([]);
        setStatus('✅ Tüm kayıtlar temizlendi');
      } else {
        throw new Error('Kayıtlar temizlenemedi');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Bilinmeyen hata';
      setStatus('❌ Kayıtlar temizlenemedi');
    }
  };
  
  

  if (mode === 'teacher' && !isAuthenticated && isTeacherAuthenticated) {
    return (
      <div className="min-h-screen p-4 bg-gray-50">
        <div className="max-w-md mx-auto p-4 bg-white rounded-xl shadow-md space-y-4">
          <p className="text-center text-lg font-semibold">Google hesabı yetkilendiriliyor...</p>
          {status && (
            <div className={`p-4 rounded-lg ${
              status.startsWith('❌') ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'
            }`}>
              <p className="font-medium">Durum:</p>
              <p className="mt-1 text-sm">{status}</p>
              {status.startsWith('❌') && (
                <div className="mt-3 text-sm space-y-2">
                  <p className="font-semibold">Çözüm Adımları:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Tarayıcı önbelleğini temizleyin</li>
                    <li>Sayfayı yenileyin (F5 veya Ctrl+R)</li>
                    <li>Google Cloud Console&apos;da OAuth ayarlarını kontrol edin</li>
                    <li>Sorun devam ederse geliştirici desteği alın</li>
                  </ol>
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="flex-1 p-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Yeniden Dene
            </button>
            <button
              onClick={() => {
                setMode('student');
                setIsTeacherAuthenticated(false);
              }}
              className="flex-1 p-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
            >
              İptal
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 bg-gray-50">

      {showFingerprintModal && (
        <FingerprintModal
          fingerprint={fingerprintToDelete}
          setFingerprint={setFingerprintToDelete}
          onSubmit={deleteFingerprint}
          onClose={() => {
            setShowFingerprintModal(false);
            setFingerprintToDelete('');
          }}
        />
      )}
      
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
            'bg-green-100 text-green-800'}`}
          >
            {status}
          </div>
        )}
  
        {mode === 'teacher' ? (
          <div className="bg-white p-6 pb-80 rounded-xl shadow-md space-y-4">
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
                  onChange={(e) => setSelectedWeek(Number(e.target.value))}
                  className="p-3 border-2 border-gray-300 rounded-lg flex-1 text-lg font-medium text-gray-700 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 appearance-none"
                  disabled={isLoading}
                >
                  {[...Array(16)].map((_, i) => (
                    <option key={i+1} value={i+1}>Hafta {i+1}</option>
                  ))}
                </select>
              </div>
  
            <button
              onClick={generateQR}
              className="w-full p-3 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700"
              disabled={isLoading}
            >
              QR Oluştur
            </button>

            <div className="absolute bottom-4 right-4 flex gap-2">
              <button
                onClick={() => setShowFingerprintModal(true)}
                className="p-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 text-sm"
                disabled={isLoading}
              >
                🔑 FP Temizle
              </button>
              <button
                onClick={clearAllRecords}
                className="p-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm"
                disabled={isLoading}
              >
                🗑️ Temizle
              </button>

              <button
                onClick={clearMemoryStore}
                className="p-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
                disabled={isLoading}
              >
                🔄 Cihaz Kayıtlarını Temizle
              </button>
            </div>

  
            {qrData && (
              <div className="mt-4 text-center relative z-[100]">
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrData)}&size=200x200`}
                  alt="QR Code"
                  className="mx-auto border-4 border-white rounded-lg shadow-lg"
                />
                <p className="mt-2 text-sm text-gray-600">15 dakika geçerli</p>
              </div>
            )}
  
            {attendance.length > 0 && (
              <div className="mt-4">
                <h3 className="text-lg font-semibold mb-2">Yoklama Listesi</h3>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {attendance.map((item, index) => (
                    <div key={index} className="p-2 bg-gray-50 rounded-lg">
                      <span className="font-medium">#{item.studentId}</span> - {item.studentName}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 p-4 bg-black text-white rounded-lg text-xs font-mono overflow-auto max-h-60 fixed bottom-4 left-4 right-4 max-w-md mx-auto z-50">
              <h3 className="text-sm font-bold mb-2">Debug Konsolu</h3>
              {debugLogs.map((log, i) => (
                <div key={i} className="whitespace-pre-wrap mb-1">{log}</div>
              ))}
            </div>
            
          </div>
          
        ) : (
          <>
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
                  className={`w-full p-3 border-2 rounded-lg text-lg font-bold tracking-wider focus:ring-2 ${
                    studentId && !validStudents.some(s => s.studentId === studentId)
                      ? 'border-red-500 focus:ring-red-500 text-red-800'
                      : 'border-blue-400 focus:ring-blue-500 text-blue-900'
                  }`}
                  disabled={isLoading}
                />
  
                {studentId && (
                  <p className={`text-sm ${
                    validStudents.some(s => s.studentId === studentId)
                      ? 'text-green-600'
                      : 'text-red-600'
                  }`}>
                    {validStudents.some(s => s.studentId === studentId)
                      ? '✅ Öğrenci numarası doğrulandı'
                      : '❌ Öğrenci numarası listede bulunamadı'}
                  </p>
                )}
  
  
                <button
                  onClick={getLocation}
                  className="w-full p-3 bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={
                    isLoading || 
                    !studentId || 
                    status.startsWith('❌') && !status.startsWith('⚠️') ||
                    !validStudents.some(s => s.studentId === studentId)
                  }
                >
                  <MapPin size={18} /> Konumu Doğrula
                </button>

                <button
                  onClick={() => setIsScanning(!isScanning)}
                  className="w-full p-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={
                    !location || 
                    !studentId || 
                    status.startsWith('❌') && !status.startsWith('⚠️') ||
                    !validStudents.some(s => s.studentId === studentId) || 
                    !isValidLocation ||
                    isLoading
                  }
                >
                  {isScanning ? '❌ Taramayı Durdur' : '📷 QR Tara'}
                </button>
  
                {isScanning && (
                  <div className="relative aspect-square bg-gray-200 rounded-xl overflow-hidden">
                    <div id="qr-reader" className="w-full h-full"></div>
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-sm">
                      QR kodu kameraya gösterin
                    </div>
                  </div>
                )}
                {connectionError && (
                  <button
                    onClick={() => {
                      setConnectionError(false);
                      setIsScanning(true);
                    }}
                    className="w-full p-3 mt-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600"
                  >
                    🔄 Bağlantıyı Yeniden Dene
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
