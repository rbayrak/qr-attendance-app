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
  
      // 2. Aynı gün içinde kullanılmış cihaz kontrolü - Skorlama sistemi
      let potentialBlockingRecord = null;
      let matchScore = 0;
      
      // Skorlama sistemi yerine, önce IP kontrolü yapmalı
      for (const [_, record] of this.memoryStore) {
        const recordDate = new Date(record.lastUsedDate);
        
        // Gün bazında karşılaştırma yap
        if (recordDate >= today && recordDate < tomorrow) {
          // YENİ: Önce IP kontrolü yap
          // Eğer IP farklıysa, farklı cihaz olarak kabul et ve devam et
          if (record.lastKnownIP !== ip) {
            continue; // IP farklı, bu farklı bir cihaz kabul ediliyor, bloklamayı atla
          }
          
          // IP'ler aynı ise artık fingerprint VE hardware'in BERABER eşleşmesini kontrol et
          // Yalnızca ikisi de eşleşirse aynı cihaz olarak kabul ediyoruz (AND mantığı)
          const hardwareMatches = record.hardwareSignature === hardwareSignature;
          const fingerprintMatches = record.fingerprints.includes(deviceFingerprint);
          
          // Hem hardware hem de fingerprint eşleşiyorsa bu kesinlikle aynı cihazdır
          const isMatchedDevice = hardwareMatches && fingerprintMatches;
          
          // Eğer aynı IP ve (hem fingerprint hem de hardware eşleşiyorsa) ve farklı öğrenciyse engelle
          if (isMatchedDevice && record.studentId !== studentId) {
            potentialBlockingRecord = record;
            break;
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
      // Öğrenci ID ve cihaz imzalarını logla (debug için)
      console.log(`Yoklama Girişi - Öğrenci: ${studentId}, FP: ${fingerprint.substring(0, 8)}..., HW: ${hardwareSignature.substring(0, 8)}..., IP: ${ip}`);
      
      // 1. Google Sheets kontrolü
      const sheetsCheck = await this.checkGoogleSheets(
        fingerprint,
        hardwareSignature,
        studentId,
        ip
      );
      
      if (!sheetsCheck.isValid) {
        console.log(`Google Sheets kontrolünde engellendi: ${sheetsCheck.error}`);
        return sheetsCheck;
      }
  
      // 2. Memory store kontrolü - Değişiklik yok, trackDevice zaten yeni IP mantığıyla güncellendi
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
    ip: string
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
  
      // Eşleşen öğrenciyi takip etmek için değişken
      let matchedStudent = null;
      
      // Tüm hücreleri kontrol et
      for (let i = 1; i < rows.length; i++) {
        // Farklı öğrenci ID'si
        if (rows[i][1] !== studentId) {
          for (let j = 3; j < rows[i].length; j++) {
            const cell = rows[i][j] || '';
            if (typeof cell === 'string') {
              // Tarih kontrolü - güncel mi?
              try {
                const dateMatch = cell.match(/\(DATE:(\d+)\)/);
                if (dateMatch) {
                  const recordDate = new Date(parseInt(dateMatch[1]));
                  
                  // Sadece bugünün kayıtları için kontrol et
                  if (recordDate >= today) {
                    // YENİ: Önce IP Adresi kontrolü
                    const ipMatch = cell.match(/\(IP:([^)]+)\)/);
                    if (ipMatch && ip) {
                      // IP aynı mı kontrol et (ilk iki okteti karşılaştırıyoruz)
                      const cellIpPrefix = ipMatch[1];
                      const currentIpPrefix = ip.split('.').slice(0, 2).join('.');
                      
                      // IP farklıysa, bu farklı bir cihaz demektir, kontrole devam et
                      if (cellIpPrefix !== currentIpPrefix) {
                        continue;
                      }
                      
                      // IP aynıysa, donanım/fingerprint kontrolü yap
                      const hasFingerprint = cell.includes(`(DF:${fingerprint.slice(0, 8)})`);
                      const hasHardware = cell.includes(`(HW:${hardwareSignature.slice(0, 8)})`);
                      
                      // Fingerprint veya hardware eşleşiyorsa bu aynı cihazdır
                      if (hasFingerprint && hasHardware) {
                        matchedStudent = rows[i][1]; // Öğrenci ID'sini tut
                        break;
                      }
                    }
                  }
                }
              } catch (error) {
                console.error('Tarih parse hatası:', error);
              }
            }
          }
          
          if (matchedStudent) break;
        }
      }
      
      // Eşleşme bulduysan engelle
      if (matchedStudent) {
        console.log(`Google Sheets'te cihaz eşleşmesi: Öğrenci=${matchedStudent}`);
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
    hardwareSignature: string,
    ipAddress?: string // ?: işareti bu parametreyi opsiyonel yapar
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
        // Yeni sayfa oluştur - 5 sütun (IP için ek sütun)
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
                      columnCount: 5 // YENİ: IP sütunu için artırıldı
                    }
                  }
                }
              }
            ]
          }
        });
        
        // Başlık satırını güncelle - IP sütunu eklendi
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'StudentDevices!A1:E1',
          valueInputOption: 'RAW',
          requestBody: {
            values: [['StudentID', 'Fingerprint', 'HardwareSignature', 'IPAddress', 'RegistrationDate']]
          }
        });
      }
      
      // IP değeri yoksa varsayılan değer kullan
      const ip = ipAddress || 'unknown';
      
      // Öğrenci kayıtlı mı kontrol et - IP sütunu için aralık genişletildi
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'StudentDevices!A:E'
      });
      
      const rows = response.data.values || [];
      const studentRowIndex = rows.findIndex(row => row[0] === studentId);
      
      if (studentRowIndex === -1) {
        // Öğrenci yoksa yeni kayıt ekle - IP sütunu eklendi
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'StudentDevices!A:E',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            // Sıralama düzeltildi: StudentID, Fingerprint, HardwareSignature, IPAddress, RegistrationDate
            values: [[studentId, fingerprint, hardwareSignature, ip, new Date().toISOString()]]
          }
        });
        console.log(`Öğrenci ${studentId} için yeni cihaz kaydedildi (IP: ${ip})`);
      } else {
        // Öğrenci varsa güncelle - IP sütunu eklendi
        // Öğrenci varsa güncelle
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: `StudentDevices!B${studentRowIndex + 1}:E${studentRowIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: {
            // Sıralama düzeltildi: Fingerprint, HardwareSignature, IPAddress, RegistrationDate
            values: [[fingerprint, hardwareSignature, ip, new Date().toISOString()]]
          }
        });
        console.log(`Öğrenci ${studentId} için cihaz güncellendi (IP: ${ip})`);
      }
    } catch (error) {
      console.error('Cihaz kayıt hatası:', error);
      throw new Error('Öğrenci cihazı kaydedilemedi');
    }
  }
  /**
   * Öğrencinin kendi cihazını kullanıp kullanmadığını doğrula
   */
  /**
 * Öğrencinin kendi cihazını kullanıp kullanmadığını doğrula
 */
  async validateStudentDevice(
    studentId: string,
    fingerprint: string,
    hardwareSignature: string,
    clientIP?: string // Opsiyonel olarak IP parametresi eklendi
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
      
      // Önce StudentDevices sayfasının var olup olmadığını kontrol et
      try {
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
          // Sayfa yoksa ilk kez yoklama alıyormuş gibi işlem yap
          console.log('StudentDevices sayfası bulunamadı, yeni sayfa oluşturulacak');
          await this.registerStudentDevice(studentId, fingerprint, hardwareSignature, clientIP);
          return { isValid: true };
        }
      } catch (error) {
        console.error('Sheet kontrol hatası:', error);
        // Hata durumunda devam et, sonraki adımlarda yeni kayıt oluşturmaya çalışacak
      }
      
      // Öğrenci-cihaz bilgilerini getir
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'StudentDevices!A:C'
        });
        
        const rows = response.data.values || [];
        
        if (rows.length > 1) {
          // Bu hardware signature veya fingerprint ile kayıtlı başka bir öğrenci var mı kontrol et
          for (let i = 1; i < rows.length; i++) {
            // Bu öğrencinin kendisi değilse ve temizlenmemiş bir kayıt ise kontrol et
            if (rows[i][0] !== studentId && 
                rows[i][1] !== 'TEMIZLENDI' && 
                rows[i][2] !== 'TEMIZLENDI') {
              
              // Hardware signature tam eşleşme kontrolü
              if (rows[i][2] === hardwareSignature) {
                console.log(`Cihaz başka öğrenciye ait: ${rows[i][0]}`);
                return { 
                  isValid: false, 
                  error: `Bu cihaz ${rows[i][0]} numaralı öğrenciye ait` 
                };
              }
              
              // Kısaltılmış hardware signature kontrolü (Sheets'te kısaltılmış değer saklanıyor olabilir)
              if (rows[i][2] && (
                  hardwareSignature.startsWith(rows[i][2]) || 
                  rows[i][2].startsWith(hardwareSignature.slice(0, 8))
                )) {
                console.log(`Cihaz başka öğrenciye ait (kısmi eşleşme): ${rows[i][0]}`);
                return { 
                  isValid: false, 
                  error: `Bu cihaz ${rows[i][0]} numaralı öğrenciye ait` 
                };
              }
              
              // Fingerprint tam eşleşme kontrolü
              if (rows[i][1] === fingerprint) {
                console.log(`Cihaz fingerprinti başka öğrenciye ait: ${rows[i][0]}`);
                return { 
                  isValid: false, 
                  error: `Bu cihaz ${rows[i][0]} numaralı öğrenciye ait` 
                };
              }
              
              // Kısaltılmış fingerprint kontrolü
              if (rows[i][1] && (
                  fingerprint.startsWith(rows[i][1]) || 
                  rows[i][1].startsWith(fingerprint.slice(0, 8))
                )) {
                console.log(`Cihaz fingerprinti başka öğrenciye ait (kısmi eşleşme): ${rows[i][0]}`);
                return { 
                  isValid: false, 
                  error: `Bu cihaz ${rows[i][0]} numaralı öğrenciye ait` 
                };
              }
            }
          }
        }
        
        // Başlık satırını atla (ilk satır)
        const studentRow = rows.slice(1).find(row => row[0] === studentId);
        
        if (!studentRow) {
          // Öğrenci daha önce cihaz kaydetmemiş, ilk kez yoklama alıyor
          console.log(`Öğrenci ${studentId} için ilk cihaz kaydı yapılacak`);
          await this.registerStudentDevice(studentId, fingerprint, hardwareSignature, clientIP);
          return { isValid: true };
        }
        
        // Kayıtlı fingerprint ve hardware signature ile karşılaştır
        const storedFingerprint = studentRow[1];
        const storedHardwareSignature = studentRow[2];
        
        console.log(`Cihaz kontrolü: Öğrenci=${studentId}, Kayıtlı FP=${storedFingerprint}, Kayıtlı HW=${storedHardwareSignature}`);
        
        // TEMIZLENDI değeri varsa, yeni cihaz bilgisini kaydet
        if (storedFingerprint === 'TEMIZLENDI' || storedHardwareSignature === 'TEMIZLENDI') {
          console.log(`Öğrenci ${studentId} için temizlenmiş cihaz kaydı bulundu, yenisi kaydediliyor`);
          await this.registerStudentDevice(studentId, fingerprint, hardwareSignature, clientIP);
          return { isValid: true };
        }
        
        // Tam eşleşme kontrolü
        const fingerprintMatches = fingerprint === storedFingerprint;
        const hardwareMatches = hardwareSignature === storedHardwareSignature;
        
        // Kısmi eşleşme kontrolü (sheets'te kısaltılmış olabilir)
        const partialFingerprintMatches = 
          fingerprint.startsWith(storedFingerprint) || 
          storedFingerprint.startsWith(fingerprint.slice(0, 8));
          
        const partialHardwareMatches = 
          hardwareSignature.startsWith(storedHardwareSignature) || 
          storedHardwareSignature.startsWith(hardwareSignature.slice(0, 8));
        
        // Hardware signature veya fingerprint eşleşiyorsa onay ver
        if (hardwareMatches || fingerprintMatches || partialHardwareMatches || partialFingerprintMatches) {
          console.log(`Öğrenci ${studentId} için cihaz doğrulandı`);
          return { isValid: true };
        }
        
        console.log(`Öğrenci ${studentId} için cihaz doğrulanamadı!`);
        return { 
          isValid: false, 
          error: `Bu cihaz ${studentId} numaralı öğrenciye ait değil` 
        };
      } catch (error) {
        console.error('Student devices veri alma hatası:', error);
        // Bu tür hatalarda, öğrencinin ilk kez yoklama almasına izin ver
        await this.registerStudentDevice(studentId, fingerprint, hardwareSignature, clientIP);
        return { isValid: true };
      }
    } catch (error) {
      console.error('Cihaz doğrulama hatası:', error);
      // Genel hata durumunda da yoklamaya izin ver, güvenlik yerine kullanılabilirliği tercih edelim
      return { isValid: true, error: 'Cihaz doğrulama sırasında hata oluştu, ancak yoklama alınmasına izin verildi' };
    }
  }

  async clearStudentDevices(): Promise<void> {
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
      
      // Önce StudentDevices sayfasının var olup olmadığını kontrol et
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
        console.log('StudentDevices sayfası bulunamadı, temizleme işlemi atlanıyor');
        return;
      }
      
      // Tüm verileri getir - IP sütunu için aralık genişletildi
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'StudentDevices!A:E'
      });
      
      const rows = response.data.values || [];
      if (rows.length <= 1) {
        console.log('StudentDevices sayfasında temizlenecek veri yok');
        return; // Sadece başlık satırı var veya hiç satır yok
      }
      
      // Başlık satırını koru, tüm cihaz bilgilerini temizle
      for (let i = 1; i < rows.length; i++) {
        // Sadece fingerprint, hardware signature ve IP sütunlarını temizle, öğrenci ID'sini ve tarihi koru
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: `StudentDevices!B${i + 1}:D${i + 1}`, // IP sütunu da dahil edildi
          valueInputOption: 'RAW',
          requestBody: {
            values: [['TEMIZLENDI', 'TEMIZLENDI', 'TEMIZLENDI']] // IP için de 'TEMIZLENDI' değeri
          }
        });
      }
      
      console.log('Tüm öğrenci cihaz eşleştirmeleri temizlendi');
    } catch (error) {
      console.error('StudentDevices temizleme hatası:', error);
      throw new Error('Öğrenci cihaz kayıtları temizlenemedi');
    }
  }
}

// Singleton instance'ı export et
export const deviceTracker = DeviceTracker.getInstance();