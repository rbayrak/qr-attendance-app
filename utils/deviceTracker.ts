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
      
      // Önce IP kontrolü yap
      for (const [_, record] of this.memoryStore) {
        const recordDate = new Date(record.lastUsedDate);
        
        // Gün bazında karşılaştırma yap
        if (recordDate >= today && recordDate < tomorrow) {
          // Eğer IP farklıysa, farklı cihaz olarak kabul et ve devam et
          if (record.lastKnownIP !== ip) {
            continue; // IP farklı, bu farklı bir cihaz kabul ediliyor
          }
          
          // IP'ler aynı ise artık fingerprint VE hardware'in BERABER eşleşmesini kontrol et
          const hardwareMatches = record.hardwareSignature === hardwareSignature;
          const fingerprintMatches = record.fingerprints.includes(deviceFingerprint);
          
          // Hem hardware hem de fingerprint eşleşiyorsa bu kesinlikle aynı cihazdır
          const isMatchedDevice = hardwareMatches && fingerprintMatches;
          
          // Eğer aynı cihaz ve farklı öğrenciyse engelle
          if (isMatchedDevice && record.studentId !== studentId) {
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
  private async getMainSheetData(): Promise<any[] | null> {
    const CACHE_DURATION = 60000; // 1 dakika önbellek süresi
    const now = Date.now();
    
    // Önbellekte geçerli veri var mı kontrol et
    if (this.sheetsCache.mainSheet && 
        (now - this.sheetsCache.mainSheet.timestamp) < CACHE_DURATION) {
      return this.sheetsCache.mainSheet.data;
    }
    
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
      // Ana sayfayı önbellekten al (veya API'den çekilir)
      const rows = await this.getMainSheetData();
      if (!rows) return { isValid: true };
  
      // Bugünün başlangıcı
      const today = new Date();
      today.setHours(0, 0, 0, 0);
  
      // Eşleşen öğrenciyi takip etmek için değişken
      let matchedStudent = null;
      
      // Tüm hücreleri kontrol et (önbellekten alındığı için daha hızlı)
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
                    // Önce IP Adresi kontrolü
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
      // Hata durumunda geçişi engelleme, devam et
      return { isValid: true };
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
      const sheets = await this.getSheetsClient();
      
      // Önce StudentDevices sayfasının var olup olmadığını kontrol et
      const sheetExists = await this.checkStudentDevicesSheetExists(sheets);
      
      if (!sheetExists) {
        // Sayfa yoksa ilk kez yoklama alıyormuş gibi işlem yap
        console.log('StudentDevices sayfası bulunamadı, yeni sayfa oluşturulacak');
        await this.registerStudentDevice(studentId, fingerprint, hardwareSignature, clientIP);
        return { isValid: true };
      }
      
      // Öğrenci-cihaz bilgilerini getir (önbellekten)
      const rows = await this.getStudentDevicesSheetData();
      
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
      console.error('Cihaz doğrulama hatası:', error);
      // Genel hata durumunda yoklamaya izin ver, kullanılabilirliği tercih edelim
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