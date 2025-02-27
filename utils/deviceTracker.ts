// src/utils/deviceTracker.ts

import { DeviceRecord, ValidationResult } from '@/types/types';
import { google } from 'googleapis';

export class DeviceTracker {
  private static instance: DeviceTracker;
  private memoryStore: Map<string, DeviceRecord>;
  private fingerprintIndex: Map<string, string[]>;

  private constructor() {
    this.memoryStore = new Map();
    this.fingerprintIndex = new Map();
  }

  // Singleton pattern
  public static getInstance(): DeviceTracker {
    if (!DeviceTracker.instance) {
      DeviceTracker.instance = new DeviceTracker();
    }
    return DeviceTracker.instance;
  }

  async trackDevice(
    deviceFingerprint: string,
    studentId: string,
    ip: string,
    hardwareSignature: string
  ): Promise<{ isAllowed: boolean; blockedReason?: string }> {
    try {
      // 1. Bugünün başlangıç ve bitiş zamanını ayarla
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // 2. Aynı gün içinde kullanılmış cihaz kontrolü - YENİ: Skorlama sistemi
      let potentialBlockingRecord = null;
      let matchScore = 0;
      
      for (const [_, record] of this.memoryStore) {
        const recordDate = new Date(record.lastUsedDate);
        
        // Gün bazında karşılaştırma yap
        if (recordDate >= today && recordDate < tomorrow) {
          // YENİ: Skorlama sistemi
          let currentScore = 0;
          
          // Hardware signature tam eşleşme (en güvenilir) (+3 puan)
          if (record.hardwareSignature === hardwareSignature) {
            currentScore += 3;
          }
          
          // Fingerprint tam eşleşme (+3 puan)
          if (record.fingerprints.includes(deviceFingerprint)) {
            currentScore += 3;
          }
          
          // IP adresi eşleşme (daha az güvenilir) (+1 puan)
          if (record.lastKnownIP === ip) {
            currentScore += 0.1;
          }
          
          // Eğer toplam skor 3 veya daha yüksekse ve farklı öğrenciyse
          // Bu cihazı potansiyel bloke edeceğiz
          if (currentScore >= 4 && record.studentId !== studentId) {
            // En yüksek skora sahip kaydı tut
            if (currentScore > matchScore) {
              matchScore = currentScore;
              potentialBlockingRecord = record;
            }
          }
        }
      }
      
      // Eğer güçlü bir eşleşme bulduysan (skorlama sistemi) ve farklı öğrenciyse
      if (potentialBlockingRecord && potentialBlockingRecord.studentId !== studentId) {
        console.log(`Cihaz eşleşmesi bulundu: Skor=${matchScore}, Öğrenci=${potentialBlockingRecord.studentId}`);
        return {
          isAllowed: false,
          blockedReason: `Bu cihaz bugün ${potentialBlockingRecord.studentId} numaralı öğrenci için kullanılmış`
        };
      }

      // 3. Yeni kayıt oluştur veya güncelle
      const existingRecord = this.memoryStore.get(hardwareSignature) || 
                          Array.from(this.memoryStore.values()).find(record => 
                            record.fingerprints.includes(deviceFingerprint));
      
      if (existingRecord) {
        // Mevcut kaydı güncelle
        existingRecord.lastUsedDate = new Date();
        existingRecord.lastKnownIP = ip;
        if (!existingRecord.fingerprints.includes(deviceFingerprint)) {
          existingRecord.fingerprints.push(deviceFingerprint);
        }
        existingRecord.usageHistory.push({
          studentId,
          timestamp: Date.now(),
          fingerprint: deviceFingerprint
        });
        this.memoryStore.set(hardwareSignature, existingRecord);
      } else {
        // Yeni kayıt oluştur
        const newRecord: DeviceRecord = {
          studentId,
          timestamp: Date.now(),
          fingerprints: [deviceFingerprint],
          hardwareSignature,
          lastKnownIP: ip,
          lastUsedDate: new Date(),
          usageHistory: [{
            studentId,
            timestamp: Date.now(),
            fingerprint: deviceFingerprint
          }]
        };
        this.memoryStore.set(hardwareSignature, newRecord);
      }

      // 4. Fingerprint indeksini güncelle
      this.updateFingerprintIndex(deviceFingerprint, hardwareSignature);

      return { isAllowed: true };
    } catch (error) {
      console.error('Device tracking error:', error);
      throw error;
    }
  }

  private updateFingerprintIndex(fingerprint: string, deviceId: string) {
    const devices = this.fingerprintIndex.get(fingerprint) || [];
    if (!devices.includes(deviceId)) {
      devices.push(deviceId);
      this.fingerprintIndex.set(fingerprint, devices);
    }
  }

  async validateDeviceAccess(
    fingerprint: string,
    studentId: string,
    ip: string,
    hardwareSignature: string
  ): Promise<ValidationResult> {
    try {
      // YENİ: Öğrenci ID ve cihaz imzalarını logla (debug için)
      console.log(`Yoklama Girişi - Öğrenci: ${studentId}, FP: ${fingerprint.substring(0, 8)}..., HW: ${hardwareSignature.substring(0, 8)}...`);
      
      // 1. Google Sheets kontrolü - ip parametresini ekliyoruz
      const sheetsCheck = await this.checkGoogleSheets(
        fingerprint,
        hardwareSignature,
        studentId,
        ip // ip parametresini ekliyoruz
      );
      
      if (!sheetsCheck.isValid) {
        console.log(`Google Sheets kontrolünde engellendi: ${sheetsCheck.error}`);
        return sheetsCheck;
      }
  
      // 2. Memory store kontrolü
      const memoryCheck = await this.trackDevice(
        fingerprint,
        studentId,
        ip,
        hardwareSignature
      );
  
      if (!memoryCheck.isAllowed) {
        console.log(`Memory kontrolünde engellendi: ${memoryCheck.blockedReason}`);
        return {
          isValid: false,
          error: memoryCheck.blockedReason
        };
      }
  
      return { isValid: true };
    } catch (error) {
      console.error('Device validation error:', error);
      return {
        isValid: false,
        error: 'Cihaz doğrulama hatası'
      };
    }
  }

  // ip parametresini ekliyoruz
  private async checkGoogleSheets(
    fingerprint: string,
    hardwareSignature: string,
    studentId: string,
    ip: string // YENİ: ip parametresi eklendi
  ): Promise<ValidationResult> {
    try {
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
  
      const sheets = google.sheets({ version: 'v4', auth });
      
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      });
  
      const rows = response.data.values;
      if (!rows) return { isValid: true };
  
      // Bugünün başlangıcı
      const today = new Date();
      today.setHours(0, 0, 0, 0);
  
      // YENİ: Eşleşme skoru ve eşleşen kayıt
      let highestScore = 0;
      let matchedStudent = null;
      
      // Tüm hücreleri kontrol et
      for (let i = 1; i < rows.length; i++) {
        // Farklı öğrenci ID'si
        if (rows[i][1] !== studentId) {
          let studentScore = 0;
          
          for (let j = 3; j < rows[i].length; j++) {
            const cell = rows[i][j] || '';
            if (typeof cell === 'string') {
              // YENİ: Başka bir öğrencinin fingerprint/hardware bilgilerine bak
              
              // Tam fingerprint eşleşme kontrolü (partial değil)
              const hasFingerprint = cell.includes(`(DF:${fingerprint})`);
              if (hasFingerprint) {
                studentScore += 3;
              }
              
              // Tam hardware signature eşleşme
              const hasHardware = cell.includes(`(HW:${hardwareSignature})`);
              if (hasHardware) {
                studentScore += 3;
              }
              
              // IP Adresi kontrolü (daha az güvenilir)
              const ipMatch = cell.match(/\(IP:([^)]+)\)/);
              if (ipMatch && ip && ip.startsWith(ipMatch[1])) {
                studentScore += 0.1;
              }
              
              // Skorları değerlendir - en yüksek skorlu eşleşmeyi tut
              if (studentScore > highestScore) {
                highestScore = studentScore;
                matchedStudent = rows[i][1]; // Öğrenci ID'sini tut
                
                // Tarih kontrolü - güncel mi?
                try {
                  const dateMatch = cell.match(/\(DATE:(\d+)\)/);
                  if (dateMatch) {
                    const recordDate = new Date(parseInt(dateMatch[1]));
                    // Sadece bugünün kayıtları için blokla
                    if (recordDate < today) {
                      // Eski kayıt, skorunu düşür
                      highestScore = 0;
                      matchedStudent = null;
                    }
                  }
                } catch (error) {
                  console.error('Tarih parse hatası:', error);
                }
              }
            }
          }
        }
      }
      
      // YENİ: Eşleşme skoruna göre değerlendir
      if (highestScore >= 4 && matchedStudent) {
        console.log(`Google Sheets'te cihaz eşleşmesi: Öğrenci=${matchedStudent}, Skor=${highestScore}`);
        return {
          isValid: false,
          error: 'Bu cihaz bugün başka bir öğrenci için kullanılmış',
          blockedStudentId: matchedStudent
        };
      }
  
      return { isValid: true };
    } catch (error) {
      console.error('Sheets check error:', error);
      return {
        isValid: false,
        error: 'Google Sheets kontrolü sırasında hata oluştu'
      };
    }
  }

  // YENİ: Debug için tüm cihaz kayıtlarını göster
  getAllDeviceRecords(): Record<string, any> {
    const records: Record<string, any> = {};
    
    for (const [key, record] of this.memoryStore.entries()) {
      records[key] = {
        ...record,
        fingerprints: record.fingerprints.map(fp => fp.substring(0, 8) + '...'),
        hardwareSignature: record.hardwareSignature.substring(0, 8) + '...'
      };
    }
    
    return records;
  }
  
  clearMemoryStore(): void {
    this.memoryStore.clear();
    this.fingerprintIndex.clear();
    console.log('Memory store temizlendi');
    return;
  }

  /**
   * Öğrencinin cihaz bilgilerini Google Sheets'te sakla
   * İlk yoklama alımında çağrılacak
   */
  async registerStudentDevice(
    studentId: string, 
    fingerprint: string,
    hardwareSignature: string
  ): Promise<void> {
    try {
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      const sheets = google.sheets({ version: 'v4', auth });
      
      // "StudentDevices" sayfası var mı kontrol et, yoksa oluştur
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: process.env.SPREADSHEET_ID
      });
      
      let sheetExists = false;
      const sheetsList = spreadsheet.data.sheets || [];
      for (const sheet of sheetsList) {
        if (sheet.properties?.title === 'StudentDevices') {
          sheetExists = true;
          break;
        }
      }
      
      if (!sheetExists) {
        // Yeni sayfa oluştur
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: process.env.SPREADSHEET_ID,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: 'StudentDevices',
                    gridProperties: {
                      rowCount: 1000,
                      columnCount: 4
                    }
                  }
                }
              }
            ]
          }
        });
        
        // Başlık satırını ekle
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'StudentDevices!A1:D1',
          valueInputOption: 'RAW',
          requestBody: {
            values: [['StudentID', 'Fingerprint', 'HardwareSignature', 'RegistrationDate']]
          }
        });
      }
      
      // Öğrenci kayıtlı mı kontrol et
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'StudentDevices!A:D'
      });
      
      const rows = response.data.values || [];
      const studentRowIndex = rows.findIndex(row => row[0] === studentId);
      
      if (studentRowIndex === -1) {
        // Öğrenci yoksa yeni kayıt ekle
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'StudentDevices!A:D',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [[studentId, fingerprint, hardwareSignature, new Date().toISOString()]]
          }
        });
        console.log(`Öğrenci ${studentId} için yeni cihaz kaydedildi`);
      } else {
        // Öğrenci varsa güncelle
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: `StudentDevices!B${studentRowIndex + 1}:D${studentRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [[fingerprint, hardwareSignature, new Date().toISOString()]]
          }
        });
        console.log(`Öğrenci ${studentId} için cihaz güncellendi`);
      }
    } catch (error) {
      console.error('Cihaz kayıt hatası:', error);
      throw new Error('Öğrenci cihazı kaydedilemedi');
    }
  }

  /**
   * Öğrencinin kendi cihazını kullanıp kullanmadığını doğrula
   */
  async validateStudentDevice(
    studentId: string,
    fingerprint: string,
    hardwareSignature: string
  ): Promise<{isValid: boolean; error?: string}> {
    try {
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      const sheets = google.sheets({ version: 'v4', auth });
      
      // Öğrenci-cihaz bilgilerini getir
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'StudentDevices!A:C'
      });
      
      const rows = response.data.values || [];
      
      // Başlık satırını atla (ilk satır)
      const studentRow = rows.slice(1).find(row => row[0] === studentId);
      
      if (!studentRow) {
        // Öğrenci daha önce cihaz kaydetmemiş, ilk kez yoklama alıyor
        console.log(`Öğrenci ${studentId} için ilk cihaz kaydı yapılacak`);
        await this.registerStudentDevice(studentId, fingerprint, hardwareSignature);
        return { isValid: true };
      }
      
      // Kayıtlı fingerprint ve hardware signature ile karşılaştır
      const storedFingerprint = studentRow[1];
      const storedHardwareSignature = studentRow[2];
      
      // Tam eşleşme kontrolü
      const fingerprintMatches = fingerprint === storedFingerprint;
      const hardwareMatches = hardwareSignature === storedHardwareSignature;
      
      // Hardware signature veya fingerprint eşleşiyorsa onay ver
      if (hardwareMatches || fingerprintMatches) {
        console.log(`Öğrenci ${studentId} için cihaz doğrulandı`);
        return { isValid: true };
      }
      
      console.log(`Öğrenci ${studentId} için cihaz doğrulanamadı!`);
      return { 
        isValid: false, 
        error: `Bu cihaz ${studentId} numaralı öğrenciye ait değil` 
      };
    } catch (error) {
      console.error('Cihaz doğrulama hatası:', error);
      return { isValid: false, error: 'Cihaz doğrulama hatası' };
    }
  }
}

// Singleton instance'ı export et
export const deviceTracker = DeviceTracker.getInstance();