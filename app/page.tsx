'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Calendar } from 'lucide-react';
import Image from 'next/image';
import { Html5Qrcode as HTML5QrCodeType } from 'html5-qrcode';

interface GoogleSheetRow { studentId: string; studentName: string; }
interface Location { lat: number; lng: number; }
interface QRCodeData { timestamp: number; classLocation: Location; validUntil: number; week: number; }
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

  // Yeni: Tarayıcı uyumluluk kontrolü
  const checkBrowserCompatibility = () => {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isSupported = !/(Firefox|Safari)/i.test(navigator.userAgent);
    
    if (!isSupported && isMobile) {
      setStatus('❌ Desteklenmeyen tarayıcı. Lütfen Chrome kullanın');
      return false;
    }
    return true;
  };

  // Güncellendi: Kamera izin yönetimi
  const startScanning = async () => {
    if (!checkBrowserCompatibility()) return;
    
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasPermission = devices.some(d => d.kind === 'videoinput' && d.label);
      
      if (!hasPermission) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(track => track.stop());
      }
      
      setIsScanning(!isScanning);
    } catch (error) {
      handleCameraError(error as Error);
    }
  };

  // Yeni: Detaylı hata yönetimi
  const handleCameraError = (error: Error) => {
    const errorMap: { [key: string]: string } = {
      NotAllowedError: 'Kamera izni reddedildi',
      NotFoundError: 'Uygun kamera bulunamadı',
      NotReadableError: 'Kamera başka uygulama tarafından kullanılıyor',
      OverconstrainedError: 'İstenen özelliklerle uyumlu kamera yok'
    };
    setStatus(`❌ ${errorMap[error.name] || 'Bilinmeyen kamera hatası'}`);
  };

  // Güncellendi: Scanner başlatma
  useEffect(() => {
    const initializeScanner = async () => {
      if (isScanning) {
        try {
          if (!document.getElementById('qr-reader')) {
            const readerDiv = document.createElement('div');
            readerDiv.id = 'qr-reader';
            document.querySelector('.scanner-container')?.appendChild(readerDiv);
          }

          const Html5Qrcode = await loadScanner();
          if (!Html5Qrcode) throw new Error('QR tarayıcı yüklenemedi');

          const scanner = new Html5Qrcode("qr-reader");
          await scanner.start(
            { facingMode: "environment" }, 
            { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
            handleQrScan,
            (errorMessage) => console.log('Tarama durumu:', errorMessage)
          );
          
          setHtml5QrCode(scanner);
        } catch (error) {
          console.error('Scanner Init Error:', error);
          setStatus(`❌ Kamera hatası: ${(error as Error).message}`);
          setIsScanning(false);
        }
      }
    };

    initializeScanner();

    return () => {
      html5QrCode?.stop().catch(console.error);
    };
  }, [isScanning]);

  // Diğer fonksiyonlar ve JSX aynı kalır...
  // (fetchStudentList, updateAttendance, getLocation, generateQR, handleStudentIdChange, handleQrScan)

  return (
    <div className="min-h-screen p-4 bg-gray-50">
      <div className="max-w-md mx-auto space-y-6">
        {/* Öğretci/Öğrenci mod butonu */}
        <button
          onClick={() => setMode(m => m === 'teacher' ? 'student' : 'teacher')}
          className="w-full p-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
        >
          {mode === 'teacher' ? '📱 Öğrenci Modu' : '👨🏫 Öğretmen Modu'}
        </button>

        {/* Durum mesajları */}
        {status && (
          <div className={`p-4 rounded-lg ${
            status.startsWith('❌') ? 'bg-red-100 text-red-800' :
            status.startsWith('⚠️') ? 'bg-yellow-100 text-yellow-800' :
            'bg-green-100 text-green-800'}`}
          >
            {status}
          </div>
        )}

        {/* Moda göre panel render */}
        {mode === 'teacher' ? (
          <div className="bg-white p-6 rounded-xl shadow-md space-y-4">
            {/* Öğretmen panel içeriği */}
          </div>
        ) : (
          <div className="bg-white p-6 rounded-xl shadow-md space-y-4">
            {/* Öğrenci panel içeriği */}
            {isScanning && (
              <div className="relative w-full aspect-square bg-gray-200 rounded-xl overflow-hidden">
                <div className="scanner-container">
                  <div id="qr-reader" style={{ minHeight: '300px' }}></div>
                </div>
                <div className="absolute inset-0 pointer-events-none bg-black/50 flex items-center justify-center text-white text-sm">
                  QR kodu kameraya gösterin
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AttendanceSystem;
