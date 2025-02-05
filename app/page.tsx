'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Calendar } from 'lucide-react';
import Image from 'next/image';
import dynamic from 'next/dynamic';

// Html5Qrcode'u dinamik olarak import ediyoruz
const Html5QrCode = dynamic(() => import('html5-qrcode').then(mod => mod.Html5Qrcode), {
  ssr: false,
});

interface Location {
  lat: number;
  lng: number;
}

interface Student {
  studentId: string;
  studentName: string;
}

interface QRCodeData {
  timestamp: number;
  classLocation: Location;
  validUntil: number;
  week: number;
}

const SPREADSHEET_ID = process.env.NEXT_PUBLIC_SHEET_ID;
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
const MAX_DISTANCE = 0.1;

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
};

export default function Home() {
  const [mode, setMode] = useState<'teacher' | 'student'>('teacher');
  const [selectedWeek, setSelectedWeek] = useState<number>(1);
  const [qrData, setQrData] = useState<string>('');
  const [location, setLocation] = useState<Location | null>(null);
  const [studentId, setStudentId] = useState<string>('');
  const [attendance, setAttendance] = useState<Student[]>([]);
  const [status, setStatus] = useState<string>('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [html5QrCode, setHtml5QrCode] = useState<any>(null);
  const [validStudents, setValidStudents] = useState<Student[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const fetchStudentList = useCallback(async () => {
    if (!SPREADSHEET_ID || !API_KEY) {
      setStatus('❌ API yapılandırması eksik');
      console.error('SPREADSHEET_ID veya API_KEY eksik');
      return;
    }

    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:C?key=${API_KEY}`;
      console.log('API URL:', url);

      const response = await fetch(url);

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        console.error('API Hata Detayları:', errorData);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('API Yanıtı:', data);

      if (!data.values || data.values.length < 2) {
        throw new Error('Geçerli veri bulunamadı');
      }

      const students = data.values.slice(1).map((row: string[]) => ({
        studentId: row[1]?.toString() || '',
        studentName: row[2]?.toString() || ''
      })).filter(student => student.studentId && student.studentName);
      
      setValidStudents(students);
      setStatus('✅ Öğrenci listesi yüklendi');
    } catch (error) {
      console.error('Öğrenci listesi çekme hatası:', error);
      setStatus('❌ Öğrenci listesi yüklenemedi: ' + (error as Error).message);
    }
  }, []);

  const updateAttendance = useCallback(async (studentId: string): Promise<boolean> => {
    if (!SPREADSHEET_ID || !API_KEY) {
      setStatus('❌ API yapılandırması eksik');
      return false;
    }

    try {
      setIsLoading(true);
      
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:Z?key=${API_KEY}`
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      const studentRow = data.values?.findIndex((row: string[]) => row[1] === studentId);
      if (studentRow === -1) throw new Error('Öğrenci bulunamadı');

      const weekColumn = String.fromCharCode(67 + selectedWeek - 1);
      const range = `${weekColumn}${studentRow + 1}`;

      const updateResponse = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?valueInputOption=RAW`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            range: range,
            majorDimension: "ROWS",
            values: [["VAR"]]
          })
        }
      );

      if (!updateResponse.ok) {
        throw new Error(`Update failed: ${updateResponse.status}`);
      }

      setStatus('✅ Yoklama kaydedildi');
      return true;
    } catch (error) {
      console.error('Yoklama güncelleme hatası:', error);
      setStatus('❌ Yoklama kaydedilemedi: ' + (error as Error).message);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [selectedWeek]);

  const getLocation = useCallback(() => {
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
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0
      }
    );
  }, []);

  const generateQR = useCallback(() => {
    if (!location) {
      setStatus('❌ Önce konum alın');
      return;
    }
    
    const payload: QRCodeData = {
      timestamp: Date.now(),
      classLocation: location,
      validUntil: Date.now() + 300000,
      week: selectedWeek
    };
    
    setQrData(JSON.stringify(payload));
    setStatus('✅ QR kod oluşturuldu');
  }, [location, selectedWeek]);

  const handleStudentIdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newId = e.target.value.trim();
    setStudentId(newId);
    
    if (newId) {
      const isValid = validStudents.some(s => s.studentId === newId);
      if (!isValid) {
        setStatus('⚠️ Bu öğrenci numarası listede yok');
      } else {
        setStatus('✅ Öğrenci numarası doğrulandı');
      }
    } else {
      setStatus('');
    }
  }, [validStudents]);

  const handleQrScan = useCallback(async (decodedText: string) => {
    try {
      const scannedData = JSON.parse(decodedText) as QRCodeData;
      
      const isValidStudent = validStudents.some(s => s.studentId === studentId);
      if (!isValidStudent) {
        setStatus('❌ Öğrenci numarası listede bulunamadı');
        return;
      }

      if (!scannedData.validUntil || scannedData.validUntil < Date.now()) {
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
          setHtml5QrCode(null);
        }
      }
    } catch (error) {
      console.error('QR tarama hatası:', error);
      setStatus('❌ Geçersiz QR kod');
    }
  }, [studentId, location, validStudents, updateAttendance, html5QrCode]);

  useEffect(() => {
    fetchStudentList();
  }, [fetchStudentList]);

  useEffect(() => {
    let scanner: any = null;
    
    const initializeScanner = async () => {
      if (isScanning && typeof window !== 'undefined') {
        try {
          if (!document.getElementById('qr-reader')) {
            console.error('QR okuyucu elementi bulunamadı');
            return;
          }

          scanner = new Html5QrCode("qr-reader");
          await scanner.start(
            { facingMode: "environment" },
            {
              fps: 10,
              qrbox: { width: 250, height: 250 },
            },
            handleQrScan,
            () => {}
          );
          setHtml5QrCode(scanner);
        } catch (error) {
          console.error('Kamera hatası:', error);
          setStatus('❌ Kamera başlatılamadı: ' + (error as Error).message);
          setIsScanning(false);
        }
      }
    };

    initializeScanner();
    return () => {
      if (scanner && scanner.isScanning) {
        scanner.stop().catch(console.error);
      }
    };
  }, [isScanning, handleQrScan]);

  return (
    <div className="min-h-screen p-4 bg-gray-50">
      <div className="max-w-md mx-auto space-y-6">
        <button
          onClick={() => setMode(m => m === 'teacher' ? 'student' : 'teacher')}
          className="w-full p-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
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

        {isLoading && (
          <div className="p-4 bg-blue-100 text-blue-800 rounded-lg">
            İşlem yapılıyor...
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
              >
                {[...Array(16)].map((_, i) => (
                  <option key={i+1} value={i+1}>Hafta {i+1}</option>
                ))}
              </select>
            </div>

            <button
              onClick={getLocation}
              disabled={isLoading}
              className="w-full p-3 bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700 disabled:opacity-50"
            >
              <Camera size={18} /> Konum Al
            </button>

            <button
              onClick={generateQR}
              disabled={!location || isLoading}
              className="w-full p-3 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700"
            >
              QR Oluştur
            </button>

            {qrData && (
              <div className="mt-4 text-center">
                <Image 
                  src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrData)}&size=200x200`}
                  alt="QR Code"
                  width={200}
                  height={200}
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
                type="text"
                value={studentId}
                onChange={handleStudentIdChange}
                placeholder="Öğrenci Numaranız"
                disabled={isLoading}
                className={`w-full p-3 border rounded-lg focus:ring-2 ${
                  studentId && !validStudents.some(s => s.studentId === studentId)
                    ? 'border-red-500 focus:ring-red-500'
                    : 'focus:ring-blue-500'
                } disabled:opacity-50`}
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
                disabled={isLoading}
                className="w-full p-3 bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700 disabled:opacity-50"
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
                  <div id="qr-reader" className="w-full h-full" style={{ minHeight: '300px' }}></div>
                  <div className="absolute inset-0 pointer-events-none bg-black/50 flex items-center justify-center text-white text-sm">
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