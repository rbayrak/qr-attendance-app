'use client';

// TypeScript için window tanımlamaları
declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}
import ytuLogo from '/ytu-logo.png';
import React, { useState, useEffect } from 'react';
//import { Camera, Calendar } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { MapPin, Calendar } from 'lucide-react';

console.log('ENV Check:', {
  SHEET_ID: process.env.NEXT_PUBLIC_SHEET_ID,
  API_KEY: process.env.NEXT_PUBLIC_GOOGLE_API_KEY,
  CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
});

const SPREADSHEET_ID = process.env.NEXT_PUBLIC_SHEET_ID;
const MAX_DISTANCE = 0.8;

// Google Auth yardımcı fonksiyonları
let tokenClient: any;
let accessToken: string | null = null;

const initializeGoogleAuth = () => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return;
    
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      reject(new Error('Client ID bulunamadı. Lütfen env değerlerini kontrol edin.'));
      return;
    }

    try {
      window.gapi.load('client:auth2', async () => {
        try {
          await window.gapi.client.init({
            apiKey: process.env.NEXT_PUBLIC_GOOGLE_API_KEY,
            clientId: clientId,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            plugin_name: 'qr-attendance'
          });

          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            callback: (tokenResponse: any) => {
              if (tokenResponse.error) {
                reject(new Error(`Token hatası: ${tokenResponse.error}`));
                return;
              }
              accessToken = tokenResponse.access_token;
              resolve(accessToken);
            },
          });

          // Token isteğini başlat
          setTimeout(() => {
            tokenClient.requestAccessToken({ prompt: 'consent' });
          }, 1000);

        } catch (error) {
          console.error('GAPI init hatası:', error);
          reject(error);
        }
      });
    } catch (error) {
      console.error('GAPI load hatası:', error);
      reject(error);
    }
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

interface Student {
  studentId: string;
  studentName: string;
}

interface Location {
  lat: number;
  lng: number;
}



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

const test1 = calculateDistance(41.015137, 28.979530, 41.015137, 28.979531); // Çok yakın iki nokta
const test2 = calculateDistance(41.015137, 28.979530, 41.015150, 28.979550); // Biraz uzak iki nokta
console.log('Mesafe test sonuçları:', {test1, test2});

const PasswordModal = ({ 
  password, 
  setPassword, 
  onSubmit, 
  onClose 
}: {
  password: string;
  setPassword: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) => (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
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

const AttendanceSystem = () => {
  const [mode, setMode] = useState<'teacher' | 'student'>('student'); // Varsayılan olarak öğrenci modu
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
  //const [deviceBlocked, setDeviceBlocked] = useState<boolean>(false);
  const [isValidLocation, setIsValidLocation] = useState<boolean>(false);
  const [classLocation, setClassLocation] = useState<Location | null>(null);

  useEffect(() => {
    if (mode === 'student') {
      const lastAttendanceCheck = localStorage.getItem('lastAttendanceCheck');
      if (lastAttendanceCheck) {
        const checkData = JSON.parse(lastAttendanceCheck);
        
        // Öğrenci numarasını set et
        setStudentId(checkData.studentId);
        
        // validStudents'ın yüklenmesini bekle
        if (validStudents.length > 0) {
          // Öğrenci kontrollerini yap
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
  }, [mode, validStudents]); // validStudents'ı dependency olarak ekledik
  
  const getClientIP = async () => {
    try {
      const response = await fetch('https://api.ipify.org?format=json');
      const data = await response.json();
      return data.ip;
    } catch (error) {
      console.error('IP adresi alınamadı:', error);
      return null;
    }
  };

  const handleModeChange = () => {
    setDebugLogs(prev => [...prev, `
      ----- Mode Değişimi Başlıyor -----
      Mevcut Mod: ${mode}
      Hedef Mod: ${mode === 'student' ? 'teacher' : 'student'}
      localStorage: ${localStorage.getItem('classLocation')}
      sessionStorage: ${sessionStorage.getItem('classLocation')}
    `]);
  
    if (mode === 'student') {
      setShowPasswordModal(true);
    } else {
      // Sayfa yenilemeden mode değiştir
      setMode('student');
      setIsTeacherAuthenticated(false);
      // Storage'ı koruyalım, temizlemeyelim
      const savedClassLocation = localStorage.getItem('classLocation');
      if (savedClassLocation) {
        setClassLocation(JSON.parse(savedClassLocation));
      }
    }
  };
  
  // handlePasswordSubmit fonksiyonunu da güncelleyelim
  const handlePasswordSubmit = () => {
    if (password === 'teacher123') {
      setIsTeacherAuthenticated(true);
      setMode('teacher');
      setShowPasswordModal(false);
      // Storage'ı koruyalım
      const savedClassLocation = localStorage.getItem('classLocation');
      if (savedClassLocation) {
        setClassLocation(JSON.parse(savedClassLocation));
      }
      // Google yetkilendirmesini başlat
      
    } else {
      setStatus('❌ Yanlış şifre');
    }
    setPassword('');
  };

  useEffect(() => {
    if (mode === 'teacher' && isTeacherAuthenticated) {
      let isMounted = true;
  
      const initAuth = async () => {
        try {
          // Google Auth başlatma
          await initializeGoogleAuth();
          
          if (isMounted) {
            setIsAuthenticated(true);
            // Token hazır olduğunda öğrenci listesini yükle
            await fetchStudentList();
          }
        } catch (error) {
          console.error('Google Auth başlatma hatası:', error);
          if (isMounted) {
            setStatus('❌ Google yetkilendirme hatası: ' + error.message);
          }
        }
      };
  
      initAuth();
  
      // Cleanup function
      return () => {
        isMounted = false;
      };
    }
  }, [mode, isTeacherAuthenticated]); // mode ve isTeacherAuthenticated değiştiğinde çalışır

  useEffect(() => {
    const loadStudentList = async () => {
      try {
        if (mode === 'student') {
          // Öğrenci modunda basit HTTP isteği ile listeyi al
          const response = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:C?key=${process.env.NEXT_PUBLIC_GOOGLE_API_KEY}`
          );
          const data = await response.json();
          
          const students = data.values.slice(1).map((row: string[]) => ({
            studentId: row[1]?.toString() || '',
            studentName: row[2]?.toString() || ''
          }));
          
          setValidStudents(students);
        }
      } catch (error) {
        console.error('Öğrenci listesi yükleme hatası:', error);
        setStatus('❌ Öğrenci listesi yüklenemedi');
      }
    };

    loadStudentList();
  }, [mode]);

  
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Öğrenci listesini Google Sheets'ten çekm

  // Frontend'deki fetchStudentList fonksiyonu
  const fetchStudentList = async () => {
    try {
      // Token kontrolü ve yenileme
      let token;
      try {
        token = await getAccessToken();
        if (!token) {
          await initializeGoogleAuth();
          token = await getAccessToken();
        }
      } catch (error) {
        console.error('Token alınamadı:', error);
        throw new Error('Google yetkilendirme hatası');
      }

      // Cache kontrolü
      const cachedList = localStorage.getItem('studentList');
      const cachedTime = localStorage.getItem('studentListTime');
      
      if (cachedList && cachedTime) {
        const timeDiff = Date.now() - parseInt(cachedTime);
        // Cache 5 dakikadan yeni ise kullan
        if (timeDiff < 5 * 60 * 1000) {
          setValidStudents(JSON.parse(cachedList));
          return;
        }
      }

      // Rate limiting için kısa bir bekleme
      await new Promise(resolve => setTimeout(resolve, 500));

      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:C`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        if (response.status === 429 || response.statusText.includes('Quota exceeded')) {
          // Quota aşıldıysa cache'den veriyi yükle
          if (cachedList) {
            setValidStudents(JSON.parse(cachedList));
            return;
          }
          throw new Error('API kotası aşıldı');
        }
        throw new Error(`API Hatası: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.values || data.values.length < 2) {
        throw new Error('Geçerli veri bulunamadı');
      }

      const students = data.values.slice(1).map((row: string[]) => ({
        studentId: row[1]?.toString() || '',
        studentName: row[2]?.toString() || ''
      })).filter(student => student.studentId && student.studentName);
      
      if (students.length === 0) {
        throw new Error('Öğrenci listesi boş');
      }

      setValidStudents(students);
      
      // Cache'e kaydet
      localStorage.setItem('studentList', JSON.stringify(students));
      localStorage.setItem('studentListTime', Date.now().toString());

    } catch (error) {
      console.error('Öğrenci listesi çekme hatası:', error);
      
      // Cache'den yüklemeyi dene
      const cachedList = localStorage.getItem('studentList');
      if (cachedList) {
        try {
          const students = JSON.parse(cachedList);
          setValidStudents(students);
          setStatus('⚠️ Cached liste kullanılıyor');
          return;
        } catch (e) {
          console.error('Cache okuma hatası:', e);
        }
      }
      
      setStatus('❌ Öğrenci listesi yüklenemedi: ' + 
        (error instanceof Error ? error.message : 'Bilinmeyen hata'));
    }
  };

  // Google Sheets'te yoklama güncelleme
  const updateAttendance = async (studentId: string) => {
    try {
      setIsLoading(true);
      
      const token = await getAccessToken();
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:Z`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );
      const data = await response.json();
      
      const studentRow = data.values.findIndex((row: string[]) => row[1] === studentId);
      if (studentRow === -1) throw new Error('Öğrenci bulunamadı');

      const weekColumn = String.fromCharCode(67 + selectedWeek - 1);
      const cellRange = `${weekColumn}${studentRow + 1}`;

      const updateResponse = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${cellRange}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            range: cellRange,
            values: [['VAR']],
            majorDimension: "ROWS",
            valueInputOption: "RAW"
          })
        }
      );

      if (!updateResponse.ok) {
        const errorData = await updateResponse.json();
        throw new Error(errorData.error?.message || 'Güncelleme hatası');
      }

      setStatus('✅ Yoklama kaydedildi');
      return true;
    } catch (error) {
      console.error('Yoklama güncelleme hatası:', error);
      setStatus(`❌ Yoklama kaydedilemedi: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}`);
      return false;
    } finally {
      setIsLoading(false);
    }
  };
  
  // getLocation fonksiyonunu güncelle (diğer fonksiyonların yanına):
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
  
        if (mode === 'teacher') {
          try {
            // Sadece API'ye kaydet
            await fetch('/api/location', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(currentLocation)
            });
            
            // Local ve session storage'a kaydet
            localStorage.setItem('classLocation', JSON.stringify(currentLocation));
            sessionStorage.setItem('classLocation', JSON.stringify(currentLocation));
            
            setClassLocation(currentLocation);
            setStatus('📍 Konum alındı');
            
            // Debug log ekle
            setDebugLogs(prev => [...prev, `
              ----- Öğretmen Konum Kaydı -----
              Kaydedilen Konum: ${currentLocation.lat}, ${currentLocation.lng}
              LocalStorage: ${localStorage.getItem('classLocation')}
              SessionStorage: ${sessionStorage.getItem('classLocation')}
            `]);
  
          } catch (error) {
            setStatus('❌ Konum kaydedilemedi');
            setDebugLogs(prev => [...prev, `
              ----- Konum Kaydetme Hatası -----
              Hata: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}
            `]);
          }
        } else if (mode === 'student') {
          // Önce localStorage'dan kontrol et
          const savedClassLocation = localStorage.getItem('classLocation');
          if (savedClassLocation) {
            const classLoc = JSON.parse(savedClassLocation);
            setClassLocation(classLoc);
            
            const distance = calculateDistance(
              currentLocation.lat,
              currentLocation.lng,
              classLoc.lat,
              classLoc.lng
            );
            
            if (distance > MAX_DISTANCE) {
              setIsValidLocation(false);
              setStatus('❌ Sınıf konumunda değilsiniz');
            } else {
              setIsValidLocation(true);
              setStatus('✅ Konum doğrulandı');
            }
            return; // Eğer localStorage'da konum varsa API'ye gitme
          }
  
          // localStorage'da yoksa API'den kontrol et
          try {
            const response = await fetch('/api/location');
            if (!response.ok) {
              setStatus('❌ Öğretmen henüz konum paylaşmamış');
              return;
            }
            
            const classLoc = await response.json();
            setClassLocation(classLoc);
            localStorage.setItem('classLocation', JSON.stringify(classLoc));
            sessionStorage.setItem('classLocation', JSON.stringify(classLoc));
            
            const distance = calculateDistance(
              currentLocation.lat,
              currentLocation.lng,
              classLoc.lat,
              classLoc.lng
            );
            
            if (distance > MAX_DISTANCE) {
              setIsValidLocation(false);
              setStatus('❌ Sınıf konumunda değilsiniz');
            } else {
              setIsValidLocation(true);
              setStatus('✅ Konum doğrulandı');
            }
          } catch (error) {
            setStatus('❌ Konum alınamadı');
          }
        }
      },
      (error) => {
        setStatus(`❌ Konum hatası: ${error.message}`);
        setIsValidLocation(false);
      }
    );
  };

  // Diğer useEffect'lerin yanına ekleyin
  useEffect(() => {
    setDebugLogs(prev => [...prev, `
      ----- Mode Değişimi -----
      Yeni Mod: ${mode}
      localStorage: ${localStorage.getItem('classLocation')}
      sessionStorage: ${sessionStorage.getItem('classLocation')}
    `]);
  
    const fetchClassLocation = async () => {
      try {
        const response = await fetch('/api/location');
        if (response.ok) {
          const classLoc = await response.json();
          setClassLocation(classLoc);
          
          // Storage'lara kaydet
          localStorage.setItem('classLocation', JSON.stringify(classLoc));
          sessionStorage.setItem('classLocation', JSON.stringify(classLoc));
    
          setDebugLogs(prev => [...prev, `
            ----- Sınıf Konumu Alındı -----
            Konum: ${JSON.stringify(classLoc)}
          `]);
        }
      } catch (error) {
        setDebugLogs(prev => [...prev, `
          ----- API Konum Alma Hatası -----
          Hata: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}
        `]);
      }
    };
  
    if (mode === 'student') {
      fetchClassLocation();
    }
  }, [mode]);

  useEffect(() => {
    if (mode === 'student') {
      // Önce localStorage'dan konum kontrolü yap
      const savedClassLocation = localStorage.getItem('classLocation');
      if (savedClassLocation) {
        const classLoc = JSON.parse(savedClassLocation);
        setClassLocation(classLoc);
        
        // Eğer öğrencinin konumu da varsa mesafe kontrolü yap
        if (location) {
          const distance = calculateDistance(
            location.lat,
            location.lng,
            classLoc.lat,
            classLoc.lng
          );
          
          if (distance > MAX_DISTANCE) {
            setIsValidLocation(false);
            setStatus('❌ Sınıf konumunda değilsiniz');
          } else {
            setIsValidLocation(true);
            setStatus('✅ Konum doğrulandı');
          }
        }
      } else {
        // localStorage'da konum yoksa API'den kontrol et
        fetch('/api/location')
          .then(response => {
            if (response.ok) {
              return response.json();
            }
            throw new Error('Konum bulunamadı');
          })
          .then(classLoc => {
            setClassLocation(classLoc);
            localStorage.setItem('classLocation', JSON.stringify(classLoc));
            sessionStorage.setItem('classLocation', JSON.stringify(classLoc));
          })
          .catch(() => {
            setStatus('❌ Öğretmen henüz konum paylaşmamış');
          });
      }
    }
  }, [mode, location]); // location dependency'sini ekledik

  const generateQR = async () => {
    if (!location) {
      setStatus('❌ Önce konum alın');
      return;
    }
    
    try {
      // Sadece API'ye kaydet
      await fetch('/api/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(location)
      });
      
      const payload = {
        timestamp: Date.now(),
        classLocation: location,
        validUntil: Date.now() + 300000,
        week: selectedWeek
      };
      
      setQrData(JSON.stringify(payload));
      setStatus('✅ QR kod oluşturuldu');
    } catch (error) {
      setStatus('❌ Konum kaydedilemedi');
    }
  };

  const handleStudentIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newId = e.target.value;
    setStudentId(newId);
    
    // Buton durumlarını resetle
    setIsValidLocation(false);
    
    if (!newId) {
      setStatus('');
      return;
    }
    
    if (validStudents.length === 0) {
      setStatus('⚠️ Öğrenci listesi henüz yüklenmedi');
      return;
    }
    
    // Öğrenciyi listede kontrol et
    const validStudent = validStudents.find(s => s.studentId === newId);
    
    if (!validStudent) {
      setStatus('⚠️ Bu öğrenci numarası listede yok');
      return;
    }
    
    // O gün için daha önce kullanılmış bir cihaz kontrolü
    const lastAttendanceCheck = localStorage.getItem('lastAttendanceCheck');
    
    if (lastAttendanceCheck) {
      const checkData = JSON.parse(lastAttendanceCheck);
      const now = new Date();
      const checkTime = new Date(checkData.timestamp);
      
      // Aynı gün içinde başka bir öğrenci numarası ile yoklama alınmış mı?
      if (now.toDateString() === checkTime.toDateString()) {
        if (checkData.studentId !== newId) {
          setStatus(`❌ Bu cihazda zaten ${checkData.studentId} numaralı öğrenci yoklaması alınmış`);
          return;
        }
      }
    }
    
    // Tüm kontrolleri geçtiyse
    setStatus('✅ Öğrenci numarası doğrulandı');
  };

  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  // handleQrScan fonksiyonu (page.tsx içinde):
  const handleQrScan = async (decodedText: string) => {
    try {
      const scannedData = JSON.parse(decodedText);
      
      // Öğrenci kontrolü
      const validStudent = validStudents.find(s => s.studentId === studentId);
      if (!validStudent) {
        setStatus('❌ Öğrenci numarası listede bulunamadı');
        return;
      }
    
      if (scannedData.validUntil < Date.now()) {
        setStatus('❌ QR kod süresi dolmuş');
        return;
      }
    
      if (!location) {
        setStatus('❌ Önce konum alın');
        return;
      }
  
      // Haftalık yoklama kontrolü ekleyelim
      const weekColumn = String.fromCharCode(68 + scannedData.week - 1); // D sütunundan başlayarak
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${weekColumn}:${weekColumn}?key=${process.env.NEXT_PUBLIC_GOOGLE_API_KEY}`
      );
      const data = await response.json();
      
      // Öğrencinin o haftaki yoklama durumunu kontrol et
      const studentRowIndex = validStudents.findIndex(s => s.studentId === studentId);
      if (studentRowIndex !== -1) {
        const weekData = data.values || [];
        const existingAttendanceCell = weekData[studentRowIndex];
        
        if (existingAttendanceCell && existingAttendanceCell[0] && existingAttendanceCell[0].includes('VAR')) {
          setStatus(`✅ Sn. ${validStudent.studentName}, bu hafta için yoklamanız zaten alınmış`);
          
          // QR taramayı durdur
          setIsScanning(false);
          if (html5QrCode) {
            await html5QrCode.stop();
          }
          return;
        }
      }
  
      // IP adresini al
      const clientIP = await getClientIP();
      if (!clientIP) {
        setStatus('❌ IP adresi alınamadı');
        return;
      }
  
      const distance = calculateDistance(
        location.lat,
        location.lng,
        scannedData.classLocation.lat,
        scannedData.classLocation.lng
      );
    
      if (distance > MAX_DISTANCE) {
        setStatus('❌ Sınıf konumunda değilsiniz');
        return;
      }
  
      const fetchResponse = await fetch('/api/attendance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          studentId: studentId,
          week: scannedData.week,
          clientIP: clientIP
        })
      });
  
      const responseData = await fetchResponse.json();
  
      // Başarılı durum kontrolü
      if (fetchResponse.ok) {
        // QR taramayı durdur
        setIsScanning(false);
        if (html5QrCode) {
          await html5QrCode.stop();
        }
  
        // Başarılı mesajını göster
        if (responseData.message) {
          setStatus(`✅ Sn. ${validStudent.studentName}, ${responseData.message.toLowerCase()}`);
        } else {
          setStatus(`✅ Sn. ${validStudent.studentName}, yoklamanız başarıyla kaydedildi`);
        }
  
        // Local storage'a kaydet
        localStorage.setItem('lastAttendanceCheck', JSON.stringify({
          studentId: studentId,
          timestamp: new Date().toISOString()
        }));
      } else {
        // Hata durumlarını kontrol et
        if (responseData.blockedStudentId) {
          setStatus(`❌ Bu cihaz bugün ${responseData.blockedStudentId} numaralı öğrenci için kullanılmış`);
        } else {
          setStatus(`❌ ${responseData.error || 'Yoklama kaydedilemedi'}`);
        }
        
        // QR taramayı durdur
        setIsScanning(false);
        if (html5QrCode) {
          await html5QrCode.stop();
        }
      }
  
    } catch (error) {
      console.error('QR okuma hatası:', error);
      setStatus(`❌ ${error instanceof Error ? error.message : 'Bilinmeyen hata'}`);
      
      // Hata durumunda QR taramayı durdur
      setIsScanning(false);
      if (html5QrCode) {
        await html5QrCode.stop();
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
  
  if (mode === 'teacher' && !isAuthenticated && isTeacherAuthenticated) {
    return (
      <div className="min-h-screen p-4 bg-gray-50">
        <div className="max-w-md mx-auto p-4 bg-white rounded-xl shadow-md space-y-4">
          <p className="text-center text-lg font-semibold">Google hesabı yetkilendiriliyor...</p>
          {status && (
            <div className="p-4 rounded-lg bg-red-100 text-red-800">
              <p className="font-medium">Hata Detayı:</p>
              <p className="mt-1">{status}</p>
              <p className="mt-2 text-sm">
                Eğer bu hata devam ederse, tarayıcı önbelleğini temizleyip sayfayı yeniden yüklemeyi deneyin.
              </p>
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
                console.log('Current ENV:', {
                  SHEET_ID: process.env.NEXT_PUBLIC_SHEET_ID,
                  API_KEY: process.env.NEXT_PUBLIC_GOOGLE_API_KEY,
                  CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
                });
              }}
              className="p-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
            >
              Debug
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 bg-gray-50">
      {/* Debug Panel */}
      <div className="mb-4 p-4 bg-black text-white rounded-lg text-xs font-mono overflow-auto max-h-40">
        {debugLogs.map((log, i) => (
          <div key={i} className="whitespace-pre-wrap">{log}</div>
        ))}
      </div>
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
              onClick={getLocation}
              className="w-full p-3 bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700"
              disabled={isLoading}
            >
              <MapPin size={18} /> Konum Al
            </button>
  
            <button
              onClick={generateQR}
              className="w-full p-3 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700"
              disabled={!location || isLoading}
            >
              QR Oluştur
            </button>
  
            {qrData && (
              <div className="mt-4 text-center">
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrData)}&size=200x200`}
                  alt="QR Code"
                  className="mx-auto border-4 border-white rounded-lg shadow-lg"
                />
                <p className="mt-2 text-sm text-gray-600">5 dakika geçerli</p>
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
              </div>
            </div>
  
            {/* Öğretmen modu butonu en alta taşındı ve stili değiştirildi */}
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