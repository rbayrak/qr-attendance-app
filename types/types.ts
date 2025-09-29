// src/types/types.ts

// Temel device kaydı için interface
export interface DeviceRecord {
  studentId: string;
  timestamp: number;
  fingerprints: string[];  // Birincil ve alternatif parmak izleri
  hardwareSignature: string;
  lastKnownIP: string;
  lastUsedDate: Date;
  usageHistory: DeviceUsage[];
}

// Cihaz kullanım geçmişi için interface
export interface DeviceUsage {
  studentId: string;
  timestamp: number;
  fingerprint: string;
}

// Doğrulama sonucu için interface
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  blockedStudentId?: string;
}

// API yanıtı için interface
export interface ResponseData {
  success?: boolean;
  error?: string;
  message?: string;
  debug?: any;
  blockedStudentId?: string;
  isAlreadyAttended?: boolean;
  unauthorizedDevice?: boolean; // YENİ: Cihaz yetkilendirme hatası flag'i
  timeout?: boolean;
}

// Konum bilgisi için interface
export interface Location {
  lat: number;
  lng: number;
}

// Öğrenci bilgisi için interface
export interface Student {
  studentId: string;
  studentName: string;
}