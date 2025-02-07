'use client';

// TypeScript için window tanımlamaları
declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

import React, { useState, useEffect } from 'react';
import { Camera, Calendar } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';

console.log('ENV Check:', {
  SHEET_ID: process.env.NEXT_PUBLIC_SHEET_ID,
  API_KEY: process.env.NEXT_PUBLIC_GOOGLE_API_KEY,
  CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
});

const SPREADSHEET_ID = process.env.NEXT_PUBLIC_SHEET_ID;
const MAX_DISTANCE = 0.1;

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
const AttendanceSystem = () => {
  const [mode, setMode] = useState<'teacher' | 'student'>('student');
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

  // useEffect içindeki initialize fonksiyonunu değiştirin
  useEffect(() => {
    const initialize = async () => {
      if (mode === 'teacher') { // Sadece öğretmen modunda yetkilendirme yap
        try {
          await initializeGoogleAuth();
          setIsAuthenticated(true);
          await fetchStudentList();
        } catch (error) {
          console.error('Google Auth hatası:', error);
          setStatus('❌ Öğretmen girişi gerekiyor');
        }
      } else { // Öğrenci modunda direkt öğrenci listesini çek
        try {
          await fetchStudentListPublic();
          setIsAuthenticated(true); // Öğrenciler için yetkilendirme gerekmez
        } catch (error) {
          setStatus('❌ Öğrenci listesi yüklenemedi');
        }
      }
    };

  initialize();
}, [mode]);

  // API key ile public erişim
  const fetchStudentListPublic = async () => {
    try {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:C?key=${process.env.NEXT_PUBLIC_GOOGLE_API_KEY}`
      );
      const data = await response.json();
      const students = data.values.slice(1).map((row: string[]) => ({
        studentId: row[1]?.toString() || '',
        studentName: row[2]?.toString() || ''
      }));
      setValidStudents(students);
    } catch (error) {
      setStatus('❌ Liste yüklenemedi');
    }
  };


  // Öğrenci listesini Google Sheets'ten çekme
  const fetchStudentList = async () => {
    try {
      const token = await getAccessToken();
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:C`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );
      const data = await response.json();
      
      const students = data.values.slice(1).map((row: string[]) => ({
        studentId: row[1]?.toString() || '',
        studentName: row[2]?.toString() || ''
      }));
      
      setValidStudents(students);
    } catch (error) {
      console.error('Öğrenci listesi çekme hatası:', error);
      setStatus('❌ Öğrenci listesi yüklenemedi');
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
  const getLocation = () => {
    if (!navigator.geolocation) {
      setStatus('❌ Konum desteği yok');
      return;
    }

    setStatus('📍 Konum alınıyor...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        });
        setStatus('📍 Konum alındı');
      },
      (error) => {
        setStatus(`❌ Konum hatası: ${error.message}`);
      }
    );
  };

  const generateQR = () => {
    if (!location) {
      setStatus('❌ Önce konum alın');
      return;
    }
    
    const payload = {
      timestamp: Date.now(),
      classLocation: location,
      validUntil: Date.now() + 300000,
      week: selectedWeek
    };
    
    setQrData(JSON.stringify(payload));
    setStatus('✅ QR kod oluşturuldu');
  };

  const handleStudentIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newId = e.target.value;
    setStudentId(newId);
    
    if (newId) {
      const isValid = validStudents.some(s => s.studentId === newId);
      if (!isValid) {
        setStatus('⚠️ Bu öğrenci numarası listede yok');
      } else {
        setStatus('✅ Öğrenci numarası doğrulandı');
      }
    }
  };

  const handleQrScan = async (decodedText: string) => {
    try {
      const scannedData = JSON.parse(decodedText);
      
      // Öğrenci kontrolü
      const isValidStudent = validStudents.some(s => s.studentId === studentId);
      if (!isValidStudent) {
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

      const success = await updateAttendance(studentId);
      if (success) {
        setIsScanning(false);
        if (html5QrCode) {
          await html5QrCode.stop();
        }
      }
    } catch (error) {
      setStatus('❌ Geçersiz QR kod');
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
  
  if (!isAuthenticated) {
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
      <div className="max-w-md mx-auto space-y-6">
        <button
          onClick={() => setMode(m => m === 'teacher' ? 'student' : 'teacher')}
          className="w-full p-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          disabled={isLoading}
        >
          {mode === 'teacher' ? '📱 Öğrenci Modu' : '👨🏫 Öğretmen Modu'}
        </button>

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
            <h2 className="text-2xl font-bold">Öğretmen Paneli</h2>
            
            <div className="flex items-center gap-2">
              <Calendar size={20} />
              <select 
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(Number(e.target.value))}
                className="p-2 border rounded-lg flex-1"
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
              <Camera size={18} /> Konum Al
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
          <div className="bg-white p-6 rounded-xl shadow-md space-y-4">
            <h2 className="text-2xl font-bold">Öğrenci Paneli</h2>
            
            <div className="space-y-4">
              <input
                value={studentId}
                onChange={handleStudentIdChange}
                placeholder="Öğrenci Numaranız"
                className={`w-full p-3 border rounded-lg focus:ring-2 ${
                  studentId && !validStudents.some(s => s.studentId === studentId)
                    ? 'border-red-500 focus:ring-red-500'
                    : 'focus:ring-blue-500'
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
                className="w-full p-3 bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700"
                disabled={isLoading}
              >
                <Camera size={18} /> Konumu Doğrula
              </button>

              <button
                onClick={() => setIsScanning(!isScanning)}
                className="w-full p-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                disabled={!location || !studentId || !validStudents.some(s => s.studentId === studentId) || isLoading}
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
        )}
      </div>
    </div>
  );
};

export default AttendanceSystem;