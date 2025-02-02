'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Calendar } from 'lucide-react';
import Image from 'next/image';
import { Html5Qrcode as HTML5QrCodeType } from 'html5-qrcode';

// Temel arayüz tanımlamaları
interface GoogleSheetRow {
  studentId: string;
  studentName: string;
}

interface Location {
  lat: number;
  lng: number;
}

interface QRCodeData {
  timestamp: number;
  classLocation: Location;
  validUntil: number;
  week: number;
}

// HTML5QrCode instance tipi
type HTML5QrCodeInstance = HTML5QrCodeType;

const SPREADSHEET_ID = process.env.NEXT_PUBLIC_SHEET_ID || '';
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY || '';
const MAX_DISTANCE = 0.1;

const loadScanner = async (): Promise<typeof HTML5QrCodeType | null> => {
  try {
    if (typeof window !== 'undefined') {
      const { Html5Qrcode } = await import('html5-qrcode');
      return Html5Qrcode;
    }
  } catch (error) {
    console.error('QR Scanner yüklenirken hata:', error);
  }
  return null;
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

const AttendanceSystem = () => {
  const [mode, setMode] = useState<'teacher' | 'student'>('teacher');
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [qrData, setQrData] = useState('');
  const [location, setLocation] = useState<Location | null>(null);
  const [studentId, setStudentId] = useState('');
  const [attendance] = useState<GoogleSheetRow[]>([]);
  const [status, setStatus] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [html5QrCode, setHtml5QrCode] = useState<HTML5QrCodeInstance | null>(null);
  const [validStudents, setValidStudents] = useState<GoogleSheetRow[]>([]);

  const fetchStudentList = async () => {
    try {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:C?key=${API_KEY}`
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

  const updateAttendance = useCallback(async (studentId: string) => {
    try {
      const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/A:Z?key=${API_KEY}`
      );
      const data = await response.json();
      
      const studentRow = data.values.findIndex((row: string[]) => row[1] === studentId);
      if (studentRow === -1) throw new Error('Öğrenci bulunamadı');

      const weekColumn = String.fromCharCode(67 + selectedWeek - 1);
      const cellRange = `${weekColumn}${studentRow + 1}`;

      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${cellRange}?valueInputOption=RAW&key=${API_KEY}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            values: [['VAR']]
          })
        }
      );

      setStatus('✅ Yoklama kaydedildi');
      return true;
    } catch (error) {
      console.error('Yoklama güncelleme hatası:', error);
      setStatus('❌ Yoklama kaydedilemedi');
      return false;
    }
  }, [selectedWeek]);

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
        console.error('Konum hatası:', error);
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

  const startScanning = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(track => track.stop());
      setIsScanning(true);
    } catch (error) {
      console.error('Kamera hatası:', error);
      setStatus('❌ Kamera izni verilmedi veya cihaz yok');
    }
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

  const handleQrScan = useCallback(async (decodedText: string) => {
    try {
      const scannedData: QRCodeData = JSON.parse(decodedText);
      
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
      console.error('QR tarama hatası:', error);
      setStatus('❌ Geçersiz QR kod');
    }
  }, [studentId, location, html5QrCode, validStudents, updateAttendance]);

  useEffect(() => {
    fetchStudentList();
  }, []);

  useEffect(() => {
    let scanner: HTML5QrCodeInstance | null = null;
    
    const initializeScanner = async () => {
      if (isScanning) {
        try {
          if (html5QrCode) {
            await html5QrCode.stop();
            setHtml5QrCode(null);
          }

          const Html5Qrcode = await loadScanner();
          if (!Html5Qrcode) {
            throw new Error('QR tarayıcı yüklenemedi');
          }

          const readerElement = document.getElementById("qr-reader");
          if (!readerElement) {
            throw new Error('QR okuyucu elementi bulunamadı');
          }

          scanner = new Html5Qrcode("qr-reader");
          
          await scanner.start(
            { facingMode: "environment" },
            {
              fps: 10,
              qrbox: { width: 250, height: 250 },
              aspectRatio: 1.0
            },
            handleQrScan,
            (errorMessage: string) => {
              console.log('QR tarama devam ediyor...', errorMessage);
            }
          );
          
          setHtml5QrCode(scanner);
        } catch (error) {
          console.error('Kamera başlatma hatası:', error);
          setStatus('❌ Kamera başlatılamadı');
          setIsScanning(false);
        }
      }
    };

    initializeScanner();

    return () => {
      if (scanner) {
        scanner.stop().catch(console.error);
      }
    };
  }, [isScanning, handleQrScan, html5QrCode]);

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
              className="w-full p-3 bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 hover:bg-blue-700"
            >
              <Camera size={18} /> Konum Al
            </button>

            <button
              onClick={generateQR}
              className="w-full p-3 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700"
              disabled={!location}
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
                value={studentId}
                onChange={handleStudentIdChange}
                placeholder="Öğrenci Numaranız"
                className={`w-full p-3 border rounded-lg focus:ring-2 ${
                  studentId && !validStudents.some(s => s.studentId === studentId)
                    ? 'border-red-500 focus:ring-red-500'
                    : 'focus:ring-blue-500'
                }`}
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
              >
                <Camera size={18} /> Konumu Doğrula
              </button>

              <button
                onClick={startScanning}  // DOĞRU
                className="w-full p-3 bg-green-600 text-white rounded-lg hover:bg-green-700"
                disabled={!location || !studentId || !validStudents.some(s => s.studentId === studentId)}
              >
                {isScanning ? '❌ Taramayı Durdur' : '📷 QR Tara'}
              </button>

              {isScanning && (
                <div className="relative w-full aspect-square bg-gray-200 rounded-xl overflow-hidden">
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
};

export default AttendanceSystem;