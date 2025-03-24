// src/utils/deviceTracker.ts

import { DeviceRecord, ValidationResult } from '@/types/types';
import { google } from 'googleapis';

export class DeviceTracker {
  private static instance: DeviceTracker;
  private memoryStore: Map<string, DeviceRecord>;
  private fingerprintIndex: Map<string, string[]>;
  
  // Önbellek ekleyelim - Google Sheets sorguları için
  private sheetsCache: {
    mainSheet: { data: any[] | null; timestamp: number } | null;
    devicesSheet: { data: any[] | null; timestamp: number } | null;
  };
  
  // API istekleri için hız sınırlama değişkenleri
  private lastSheetsApiCall: number = 0;
  private readonly API_CALL_DELAY: number = 100; // 100ms minimum gecikme

  private constructor() {
    this.memoryStore = new Map();
    this.fingerprintIndex = new Map();
    this.sheetsCache = {
      mainSheet: null,
      devicesSheet: null
    };
  }

  // Singleton pattern
  public static getInstance(): DeviceTracker {
    if (!DeviceTracker.instance) {
      DeviceTracker.instance = new DeviceTracker();
    }
    return DeviceTracker.instance;
  }

  // Yeniden deneme mekanizması ekleyelim
  private async retryableOperation<T>(operation: () => Promise<T>, maxRetries = 5): Promise<T> {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // API çağrıları arasında minimum gecikme ekleyelim
        const now = Date.now();
        const timeSinceLastCall = now - this.lastSheetsApiCall;
        
        if (timeSinceLastCall < this.API_CALL_DELAY) {
          await new Promise(resolve => setTimeout(resolve, this.API_CALL_DELAY - timeSinceLastCall));
        }
        
        this.lastSheetsApiCall = Date.now();
        return await operation();
      } catch (error: any) {
        lastError = error;
        
        // API limit aşımı veya geçici hata durumlarında yeniden dene
        if (error.code === 429 || error.code === 503 || error.code === 'ECONNRESET') {
          // Exponential backoff (her denemede daha uzun süre bekle)
          const delay = Math.min(Math.pow(2, attempt) * 1000, 10000); // Max 10 saniye
          console.log(`API hatası, ${delay}ms bekleyip yeniden deneniyor. Deneme: ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Diğer hatalarda yeniden deneme yapma
        throw error;
      }
    }
    
    throw lastError;
  }

  // paste-3.txt dosyasına yeni metod ekleyin (DeviceTracker sınıfına)
  async clearSheetWeek(weekNumber: number): Promise<number> {
    try {
      const sheets = await this.getSheetsClient();
      const rows = await this.getMainSheetData(true);
      let updateCount = 0;
      
      if (rows && rows.length > 0) {
        const weekColumnIndex = 3 + (weekNumber - 1);
        const columnLetter = String.fromCharCode(65 + weekColumnIndex);
        
        // Toplu güncelleme için hücreleri toplayalım
        const batchUpdates = [];
        
        // Tüm satırları dolaş ve güncelleme ihtiyacı olanları belirle
        for (let i = 1; i < rows.length; i++) {
          if (!rows[i]) continue;
          
          if (weekColumnIndex < rows[i].length) {
            const cell = rows[i][weekColumnIndex];
            
            if (cell && (cell.includes('(DF:') || cell.includes('(HW:') || cell.includes('(DATE:'))) {
              const range = `${columnLetter}${i + 1}`;
              batchUpdates.push({
                range: `${process.env.SPREADSHEET_ID}!${range}`,
                values: [['VAR']]
              });
              updateCount++;
            }
          }
        }
        
        // Eğer güncelleme yapılacak hücre varsa, toplu güncelleme yap
        if (batchUpdates.length > 0) {
          // Gruplar halinde güncelleme yap (her seferde maksimum 20 hücre)
          const BATCH_SIZE = 20;
          for (let i = 0; i < batchUpdates.length; i += BATCH_SIZE) {
            const currentBatch = batchUpdates.slice(i, i + BATCH_SIZE);
            
            await this.retryableOperation(() => 
              sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: process.env.SPREADSHEET_ID,
                requestBody: {
                  valueInputOption: 'RAW',
                  data: currentBatch
                }
              })
            );
            
            // Her grup sonrası kısa bekleme
            if (i + BATCH_SIZE < batchUpdates.length) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        }
      }
      
      return updateCount;
    } catch (error) {
      console.error('Hafta temizleme hatası:', error);
      throw error;
    }
  }

// getMainSheetData metodunu public yapın (private -> public)

  // Google Auth yardımcı fonksiyonu
  private async getGoogleAuth() {
    return new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  // Sheets API çağrısı için yardımcı fonksiyon
  private async getSheetsClient() {
    const auth = await this.getGoogleAuth();
    return google.sheets({ version: 'v4', auth });
  }


  // DeviceTracker sınıfına eklenecek yeni fonksiyon
  private calculateDeviceSimilarity(
    fingerprint1: string,
    fingerprint2: string,
    hardware1: string,
    hardware2: string
  ): number {
    let score = 0;
    
    // Fingerprint benzerlik hesabı (40 puan)
    if (fingerprint1 === fingerprint2) {
      score += 40; // Tam eşleşme
    } else if (fingerprint1.startsWith(fingerprint2.slice(0, 8)) || 
              fingerprint2.startsWith(fingerprint1.slice(0, 8))) {
      // Kısmi eşleşmede 20 puan
      score += 20;
    }
    
    // Hardware signature benzerlik hesabı (60 puan - daha güvenilir)
    if (hardware1 === hardware2) {
      score += 60; // Tam eşleşme
    } else if (hardware1.startsWith(hardware2.slice(0, 8)) || 
              hardware2.startsWith(hardware1.slice(0, 8))) {
      // Kısmi eşleşmede 30 puan
      score += 30;
    }
    
    return score;
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
  
      // 2. Aynı gün içinde kullanılmış cihaz kontrolü
      let potentialBlockingRecord = null;
      
      // Tüm kayıtları kontrol et
      for (const [_, record] of this.memoryStore) {
        const recordDate = new Date(record.lastUsedDate);
        
        // Sadece bugünün kayıtlarını kontrol et
        if (recordDate >= today && recordDate < tomorrow) {
          // Eğer IP farklıysa, farklı cihaz olarak kabul et ve devam et
          if (record.lastKnownIP !== ip) {
            continue; // Kesinlikle farklı cihaz
          }
          
          // IP'ler aynı ise fingerprint ve hardware benzerliğini kontrol et
          const similarityScore = this.calculateDeviceSimilarity(
            record.fingerprints[0], // İlk kaydedilen fingerprint
            deviceFingerprint,
            record.hardwareSignature,
            hardwareSignature
          );
  
          // Benzerlik skoru 50'den büyükse, aynı cihaz olarak kabul et
          const isSameDevice = similarityScore >= 50;
          
          // Eğer aynı cihaz ve farklı öğrenciyse engelle
          if (isSameDevice && record.studentId !== studentId) {
            potentialBlockingRecord = record;
            break;
          }
        }
      }
      
      // Eğer eşleşme bulduysan ve farklı öğrenciyse
      if (potentialBlockingRecord && potentialBlockingRecord.studentId !== studentId) {
        console.log(`Cihaz eşleşmesi bulundu: Öğrenci=${potentialBlockingRecord.studentId}`);
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
      
      // 1. Google Sheets kontrolü (yeniden deneme mekanizması ile)
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

  // Google Sheets ana sayfasını önbellekten veya API'den alır
  public async getMainSheetData(forceRefresh?: boolean): Promise<any[] | null> {
    const CACHE_DURATION = 60000; // 1 dakika önbellek süresi
    const now = Date.now();
    
    // Eğer forceRefresh true ise veya önbellek süresi dolmuşsa, yeniden veri al
    if (forceRefresh || 
        !this.sheetsCache.mainSheet || 
        (now - this.sheetsCache.mainSheet.timestamp) >= CACHE_DURATION) {
        
        // Yoksa API'den al
        try {
            const sheets = await this.getSheetsClient();
            
            const response = await this.retryableOperation(() => 
                sheets.spreadsheets.values.get({
                    spreadsheetId: process.env.SPREADSHEET_ID,
                    range: 'A:Z',
                })
            );
            
            // Önbelleğe al
            this.sheetsCache.mainSheet = {
                data: response.data.values || [],
                timestamp: now
            };
            
            return response.data.values || [];
        } catch (error) {
            console.error('Sheets veri alma hatası:', error);
            throw error;
        }
    }
    
    // Önbellekte geçerli veri var
    return this.sheetsCache.mainSheet.data;
  }

  // Google Sheets StudentDevices sayfasını önbellekten veya API'den alır
  private async getStudentDevicesSheetData(): Promise<any[]> {
    const CACHE_DURATION = 60000; // 1 dakika önbellek süresi
    const now = Date.now();
    
    // Önbellekte geçerli veri var mı kontrol et
    if (this.sheetsCache.devicesSheet && 
        (now - this.sheetsCache.devicesSheet.timestamp) < CACHE_DURATION) {
      return this.sheetsCache.devicesSheet.data || [];
    }
    
    // Yoksa API'den al
    try {
      const sheets = await this.getSheetsClient();
      
      const response = await this.retryableOperation(() => 
        sheets.spreadsheets.values.get({
          spreadsheetId: process.env.SPREADSHEET_ID,
          range: 'StudentDevices!A:E',
        })
      );
      
      // Önbelleğe al
      this.sheetsCache.devicesSheet = {
        data: response.data.values || [],
        timestamp: now
      };
      
      return response.data.values || [];
    } catch (error) {
      console.error('StudentDevices veri alma hatası:', error);
      // Boş dizi döndürerek sonraki logicteki null kontrollerini atla
      return [];
    }
  }

  // ip parametresi ekliyoruz
  private async checkGoogleSheets(
    fingerprint: string,
    hardwareSignature: string,
    studentId: string,
    ip: string
  ): Promise<ValidationResult> {
    try {
      // Ana sayfayı önbellekten al
      const rows = await this.getMainSheetData();
      if (!rows) return { isValid: true };
  
      // Bugünün başlangıcı
      const today = new Date();
      today.setHours(0, 0, 0, 0);
  
      // Eşleşen öğrenciyi takip etmek için değişken
      let matchedStudent = null;
      
      // Tüm hücreleri kontrol et
      for (let i = 1; i < rows.length; i++) {
        // Sadece farklı öğrenci ID'leri için kontrol et
        if (rows[i][1] !== studentId) {
          for (let j = 3; j < rows[i].length; j++) {
            const cell = rows[i][j] || '';
            if (typeof cell === 'string') {
              // Tarih kontrolü - bugünün kaydı mı?
              try {
                const dateMatch = cell.match(/\(DATE:(\d+)\)/);
                if (dateMatch) {
                  const recordDate = new Date(parseInt(dateMatch[1]));
                  
                  // Sadece bugünün kayıtları için kontrol et
                  if (recordDate >= today) {
                    // IP kontrolü
                    const ipMatch = cell.match(/\(IP:([^)]+)\)/);
                    if (ipMatch && ip) {
                      // IP aynı mı kontrol et (artık tam IP karşılaştırması)
                      const cellIp = ipMatch[1];
                      
                      // IP farklıysa, bu farklı bir cihaz demektir
                      if (cellIp !== ip) {
                        continue;
                      }
                      
                      // IP aynıysa, donanım/fingerprint kontrolü yap
                      const hasFingerprint = cell.includes(`(DF:${fingerprint.slice(0, 8)})`);
                      const hasHardware = cell.includes(`(HW:${hardwareSignature.slice(0, 8)})`);
                      
                      // Benzerlik skoru hesapla (basitleştirilmiş)
                      let similarityScore = 0;
                      if (hasFingerprint) similarityScore += 40;
                      if (hasHardware) similarityScore += 30;
                      
                      // Benzerlik skoru 40 veya üzerindeyse, bu aynı cihazdır
                      if (similarityScore >= 40) {
                        matchedStudent = rows[i][1];
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
      return { isValid: true }; // Hata durumunda geçişe izin ver
    }
  }

  // Debug için tüm cihaz kayıtlarını göster
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
    // Önbelleği de temizle
    this.sheetsCache = {
      mainSheet: null,
      devicesSheet: null
    };
    console.log('Memory store ve önbellek temizlendi');
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
    ipAddress?: string
  ): Promise<void> {
    try {
      const sheets = await this.getSheetsClient();
      
      // "StudentDevices" sayfası var mı kontrol et, yoksa oluştur
      const sheetExists = await this.checkStudentDevicesSheetExists(sheets);
      
      if (!sheetExists) {
        // Yeni sayfa oluştur - 5 sütun (IP için ek sütun)
        await this.retryableOperation(() => 
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.SPREADSHEET_ID,
            requestBody: {
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: 'StudentDevices',
                      gridProperties: {
                        rowCount: 1000,
                        columnCount: 5
                      }
                    }
                  }
                }
              ]
            }
          })
        );
        
        // Başlık satırını güncelle - IP sütunu eklendi
        await this.retryableOperation(() => 
          sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'StudentDevices!A1:E1',
            valueInputOption: 'RAW',
            requestBody: {
              values: [['StudentID', 'Fingerprint', 'HardwareSignature', 'IPAddress', 'RegistrationDate']]
            }
          })
        );
      }
      
      // IP değeri yoksa varsayılan değer kullan
      const ip = ipAddress || 'unknown';
      
      // Öğrenci-cihaz verilerini al (önbellekten)
      const rows = await this.getStudentDevicesSheetData();
      const studentRowIndex = rows.findIndex(row => row[0] === studentId);
      
      if (studentRowIndex === -1) {
        // Öğrenci yoksa yeni kayıt ekle
        await this.retryableOperation(() => 
          sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'StudentDevices!A:E',
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
              values: [[studentId, fingerprint, hardwareSignature, ip, new Date().toISOString()]]
            }
          })
        );
        
        // Önbelleği temizle
        this.sheetsCache.devicesSheet = null;
        
        console.log(`Öğrenci ${studentId} için yeni cihaz kaydedildi (IP: ${ip})`);
      } else {
        // Öğrenci varsa güncelle
        await this.retryableOperation(() => 
          sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: `StudentDevices!B${studentRowIndex + 1}:E${studentRowIndex + 1}`,
            valueInputOption: 'RAW',
            requestBody: {
              values: [[fingerprint, hardwareSignature, ip, new Date().toISOString()]]
            }
          })
        );
        
        // Önbelleği temizle
        this.sheetsCache.devicesSheet = null;
        
        console.log(`Öğrenci ${studentId} için cihaz güncellendi (IP: ${ip})`);
      }
    } catch (error) {
      console.error('Cihaz kayıt hatası:', error);
      // Kritik olmayan hatada devam et
      console.log('Hataya rağmen işleme devam ediliyor');
    }
  }

  // StudentDevices sayfasının var olup olmadığını kontrol et
  // StudentDevices sayfasının var olup olmadığını kontrol et
  private async checkStudentDevicesSheetExists(sheets: any): Promise<boolean> {
    try {
      // 'any' tipi kullanarak tip hatasını engelleyelim
      const response: any = await this.retryableOperation(() => 
        sheets.spreadsheets.get({
          spreadsheetId: process.env.SPREADSHEET_ID
        })
      );
      
      const sheetsList = response.data.sheets || [];
      for (const sheet of sheetsList) {
        if (sheet.properties?.title === 'StudentDevices') {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.error('Sheet kontrol hatası:', error);
      return false;
    }
  }

  /**
   * Öğrencinin kendi cihazını kullanıp kullanmadığını doğrula
   */
  async validateStudentDevice(
    studentId: string,
    fingerprint: string,
    hardwareSignature: string,
    clientIP?: string
  ): Promise<{isValid: boolean; error?: string}> {
    try {
      // Artık öğrencinin kendi cihazını kullanıp kullanmadığını kontrol etmiyoruz
      // Sadece cihazın ilk kez kullanılması durumunda kaydedelim
      
      const sheets = await this.getSheetsClient();
      const sheetExists = await this.checkStudentDevicesSheetExists(sheets);
      
      if (!sheetExists) {
        // Sayfa yoksa oluştur ve ilk kaydı ekle
        await this.registerStudentDevice(studentId, fingerprint, hardwareSignature, clientIP);
      } else {
        // Sayfa varsa, bu öğrenci için kayıt var mı kontrol et
        const rows = await this.getStudentDevicesSheetData();
        const studentRow = rows.slice(1).find(row => row[0] === studentId);
        
        // Öğrenci kaydı yoksa veya "TEMIZLENDI" ise yeni kayıt ekle
        if (!studentRow || 
            studentRow[1] === 'TEMIZLENDI' || 
            studentRow[2] === 'TEMIZLENDI') {
          await this.registerStudentDevice(studentId, fingerprint, hardwareSignature, clientIP);
        }
        // Öğrencinin kayıtlı cihazı olsa bile kontrol etmiyoruz artık
      }
      
      // Her durumda izin ver - öğrencinin aynı/farklı cihaz kullanması önemli değil
      return { isValid: true };
    } catch (error) {
      console.error('Cihaz doğrulama hatası:', error);
      return { isValid: true, error: 'Cihaz doğrulama sırasında hata oluştu, ancak yoklama alınmasına izin verildi' };
    }
  }

  async clearStudentDevices(): Promise<void> {
    try {
      const sheets = await this.getSheetsClient();
      
      // Önce StudentDevices sayfasının var olup olmadığını kontrol et
      const sheetExists = await this.checkStudentDevicesSheetExists(sheets);
      
      if (!sheetExists) {
        console.log('StudentDevices sayfası bulunamadı, temizleme işlemi atlanıyor');
        return;
      }
      
      // Tüm verileri getir
      const rows = await this.getStudentDevicesSheetData();
      if (rows.length <= 1) {
        console.log('StudentDevices sayfasında temizlenecek veri yok');
        return; // Sadece başlık satırı var veya hiç satır yok
      }
      
      // Başlık satırını koru, tüm cihaz bilgilerini temizle
      for (let i = 1; i < rows.length; i++) {
        // Toplu güncellemeler yerine daha küçük batch'ler halinde yap
        if (i % 10 === 0) {
          // Her 10 satırda bir kısa bekleme ekle
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        await this.retryableOperation(() => 
          sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: `StudentDevices!B${i + 1}:D${i + 1}`,
            valueInputOption: 'RAW',
            requestBody: {
              values: [['TEMIZLENDI', 'TEMIZLENDI', 'TEMIZLENDI']]
            }
          })
        );
      }
      
      // Önbelleği temizle
      this.sheetsCache.devicesSheet = null;
      
      console.log('Tüm öğrenci cihaz eşleştirmeleri temizlendi');
    } catch (error) {
      console.error('StudentDevices temizleme hatası:', error);
      throw new Error('Öğrenci cihaz kayıtları temizlenemedi');
    }
  }
}

// Singleton instance'ı export et
export const deviceTracker = DeviceTracker.getInstance();