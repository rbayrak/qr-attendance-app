// pages/api/attendance.ts

import { NextApiRequest, NextApiResponse } from 'next';
import { ResponseData } from '@/types/types';
import { deviceTracker } from '@/utils/deviceTracker';
import { google } from 'googleapis';

// API istek kuyruğu
interface QueueItem {
  req: NextApiRequest;
  res: NextApiResponse<ResponseData>;
  timestamp: number;
}

// Kuyruk yapısı
let processingQueue: boolean = false;
let requestQueue: QueueItem[] = [];

// Önbellek
const cache = {
  mainSheet: {
    data: null as any[] | null,
    timestamp: 0
  },
  studentLookup: new Map<string, number>() // Öğrenci ID -> satır indeksi eşlemesi
};

// Sheets API işlemleri için yardımcı fonksiyonlar
async function getGoogleAuth() {
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

async function getSheetsClient() {
  const auth = await getGoogleAuth();
  return google.sheets({ version: 'v4', auth });
}

// Yeniden deneme mekanizması
async function retryableOperation<T>(operation: () => Promise<T>, maxRetries = 5): Promise<T> {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // İstekler arasında minimum gecikme
      if (attempt > 0) {
        // Exponential backoff (her denemede daha uzun süre bekle)
        const delay = Math.min(Math.pow(2, attempt) * 1000, 10000); // Max 10 saniye
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // API limit aşımı veya geçici hata durumlarında yeniden dene
      if (error.code === 429 || error.code === 503 || error.code === 'ECONNRESET') {
        console.log(`API hatası, yeniden deneniyor. Deneme: ${attempt + 1}/${maxRetries}`);
        continue;
      }
      
      // Diğer hatalarda yeniden deneme yapma
      throw error;
    }
  }
  
  throw lastError;
}

// Ana sayfayı önbellekten veya API'den al
async function getMainSheetData(forceRefresh = false): Promise<any[] | null> {
  const CACHE_DURATION = 2000; // 2 saniye önbellek süresi (fingerprint çakışması için)
  const now = Date.now();
  
  // Önbellekte geçerli veri var mı kontrol et
  if (!forceRefresh && 
      cache.mainSheet.data && 
      (now - cache.mainSheet.timestamp) < CACHE_DURATION) {
    return cache.mainSheet.data;
  }
  
  // Yoksa API'den al
  try {
    const sheets = await getSheetsClient();
    
    const response = await retryableOperation(() => 
      sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      })
    );
    
    const data = response.data.values || [];
    
    // Öğrenci indekslerini önbelleğe al
    cache.studentLookup.clear();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1]) { // Öğrenci ID'si
        cache.studentLookup.set(data[i][1], i);
      }
    }
    
    // Önbelleğe al
    cache.mainSheet = {
      data,
      timestamp: now
    };
    
    return data;
  } catch (error) {
    console.error('Sheets veri alma hatası:', error);
    // Önbellekteki eski verileri döndürmeye çalış
    return cache.mainSheet.data;
  }
}

// Ana API handler 
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method === 'POST') {
    // POST isteklerini kuyruğa ekle
    requestQueue.push({
      req,
      res,
      timestamp: Date.now()
    });
    
    // Kuyruk işlenmiyorsa başlat
    if (!processingQueue) {
      processQueue();
    }
  }
  else if (req.method === 'DELETE') {
    // DELETE istekleri doğrudan işleniyor (daha az yoğun olduğu için)
    await handleDeleteRequest(req, res);
  }
  else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

// İstek kuyruğunu işleyen fonksiyon
async function processQueue() {
  processingQueue = true;
  
  while (requestQueue.length > 0) {
    const { req, res } = requestQueue.shift()!;
    
    try {
      await processPostRequest(req, res);
    } catch (error) {
      console.error('Queue processing error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : 'Bilinmeyen hata'
      });
    }
    
    // API rate limit aşımını önlemek için küçük bir bekleme
    // 60 kişilik sınıflar için optimize edildi: 50ms
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  processingQueue = false;
}

// POST isteklerini işleyen asıl fonksiyon
// POST isteklerini işleyen asıl fonksiyon
async function processPostRequest(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  try {
    const { 
      studentId, 
      week, 
      clientIP, 
      deviceFingerprint,
      hardwareSignature 
    } = req.body;

    // 1. Temel validasyonlar
    if (!studentId || !week) {
      return res.status(400).json({ 
        error: 'Öğrenci ID ve hafta bilgisi gerekli' 
      });
    }

    if (!deviceFingerprint || !hardwareSignature) {
      return res.status(400).json({ 
        error: 'Cihaz tanımlama bilgileri eksik' 
      });
    }

    // 2. Öğrenci cihaz kaydı (önceki kontrol kaldırıldı)
    // Artık bu fonksiyon her zaman { isValid: true } dönecek
    await deviceTracker.validateStudentDevice(
      studentId, 
      deviceFingerprint,
      hardwareSignature,
      clientIP
    );

    // 3. Device Tracker kontrolü - asıl önemli olan kontrol
    // "Bugün başka öğrenci tarafından kullanılmış mı?" kontrolü
    const validationResult = await deviceTracker.validateDeviceAccess(
      deviceFingerprint,
      studentId,
      clientIP,
      hardwareSignature
    );

    if (!validationResult.isValid) {
      return res.status(403).json({ 
        error: validationResult.error,
        blockedStudentId: validationResult.blockedStudentId 
      });
    }

    // 4. Ana sayfayı önbellekten al
    const rows = await getMainSheetData();
    if (!rows) {
      return res.status(404).json({ error: 'Veri bulunamadı' });
    }

    // 5. Öğrenciyi bul (önbellekten)
    let studentRowIndex = -1;
    if (cache.studentLookup.has(studentId)) {
      studentRowIndex = cache.studentLookup.get(studentId)!;
    } else {
      // Önbellekte yoksa elle ara
      studentRowIndex = rows.findIndex(row => row[1] === studentId);
      if (studentRowIndex > 0) {
        cache.studentLookup.set(studentId, studentRowIndex);
      }
    }

    if (studentRowIndex === -1) {
      return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    }

    // 6. Hafta kontrolü
    if (week < 1 || week > 16) {
      return res.status(400).json({ error: 'Geçersiz hafta numarası' });
    }

    // 7. Hafta sütununu belirle
    const weekColumnIndex = 3 + Number(week) - 1;
    const studentRow = studentRowIndex + 1;
    const weekColumn = String.fromCharCode(68 + Number(week) - 1);
    const range = `${weekColumn}${studentRow}`;

    // 8. Mevcut yoklama kontrolü
    const isAlreadyAttended = rows[studentRowIndex][weekColumnIndex] && 
                            rows[studentRowIndex][weekColumnIndex].includes('VAR');

    
    // 9. Sheets client'ı al
    const sheets = await getSheetsClient();

    // 10. Yoklamayı kaydet (her durumda)
    const updateResult = await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: range,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[`VAR (DF:${deviceFingerprint.slice(0, 8)}) (HW:${hardwareSignature.slice(0, 8)}) (IP:${clientIP}) (DATE:${Date.now()})`]]
      }
    });


    // 11. Önbelleği güncelle (yoklama bilgileri değişti)
    if (rows[studentRowIndex]) {
      rows[studentRowIndex][weekColumnIndex] = `VAR (DF:${deviceFingerprint.slice(0, 8)}) (HW:${hardwareSignature.slice(0, 8)}) (IP:${clientIP}) (DATE:${Date.now()})`;
    }

    // 12. Başarılı yanıt
    res.status(200).json({ 
      success: true,
      isAlreadyAttended: isAlreadyAttended, // Burada öğrencinin önceden yoklama alıp almadığı bilgisini gönderiyoruz
      debug: {
        operationDetails: {
          ogrenciNo: studentId,
          bulunanSatir: studentRow,
          sutun: weekColumn,
          aralik: range,
          weekNumber: week,
          deviceFingerprint: deviceFingerprint.slice(0, 8) + '...' // Güvenlik için kısalt
        },
        updateResult: updateResult.data
      }
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Bilinmeyen hata'
    });
  }
}

// DELETE isteklerini işleyen fonksiyon
// DELETE isteklerini işleyen fonksiyon
// DELETE isteklerini işleyen fonksiyon
// DELETE isteklerini işleyen fonksiyon
// DELETE isteklerini işleyen fonksiyon
async function handleDeleteRequest(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  const { fingerprint, cleanStep } = req.query;

  try {
    if (fingerprint) {
      // 1. Google Sheets'ten fingerprint'i temizle
      const sheets = await getSheetsClient();
      
      // Önbellekli veriyi al
      const rows = await getMainSheetData();
      if (!rows) {
        return res.status(404).json({ error: 'Veri bulunamadı' });
      }

      let fingerprintFound = false;

      // Fingerprint'i bul ve temizle
      for (let i = 0; i < rows.length; i++) {
        for (let j = 3; j < rows[i].length; j++) {
          const cell = rows[i][j];
          if (cell && cell.includes(`(DF:${fingerprint})`)) {
            fingerprintFound = true;
            const range = `${String.fromCharCode(65 + j)}${i + 1}`;
            
            await retryableOperation(() => 
              sheets.spreadsheets.values.update({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: range,
                valueInputOption: 'RAW',
                requestBody: {
                  values: [['VAR']]
                }
              })
            );
            
            // Önbelleği güncelle
            if (rows[i]) {
              rows[i][j] = 'VAR';
            }
          }
        }
      }

      if (!fingerprintFound) {
        return res.status(404).json({ error: 'Fingerprint bulunamadı' });
      }

      // 2. StudentDevices sayfasında da temizle
      try {
        const devicesResponse = await retryableOperation(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'StudentDevices!A:C',
          })
        );
        
        const deviceRows = devicesResponse.data.values || [];
        
        for (let i = 1; i < deviceRows.length; i++) {
          if (deviceRows[i][1] && deviceRows[i][1].includes(fingerprint)) {
            await retryableOperation(() =>
              sheets.spreadsheets.values.update({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `StudentDevices!B${i + 1}`,
                valueInputOption: 'RAW',
                requestBody: {
                  values: [['TEMIZLENDI']]
                }
              })
            );
            console.log(`StudentDevices tablosunda ${fingerprint} temizlendi`);
          }
        }
      } catch (error) {
        console.error('StudentDevices temizleme hatası:', error);
        // Bu hata kritik değil, devam et
      }

      // Önbelleği yenile
      await getMainSheetData(true);

      return res.status(200).json({ 
        success: true,
        message: `${fingerprint} fingerprint'i silindi`
      });
    } 
    else if (cleanStep) {
      // Aşamalı temizleme işlemi
      if (cleanStep === 'memory') {
        // Memory store ve StudentDevices sayfasını temizle
        deviceTracker.clearMemoryStore();
        
        // StudentDevices sayfasını da temizle
        try {
          await deviceTracker.clearStudentDevices();
          console.log('StudentDevices sayfası temizlendi');
        } catch (error) {
          console.error('StudentDevices temizleme hatası:', error);
          // Kritik olmayan hata, devam et
        }
        
        // Önbelleği temizle
        cache.mainSheet = {
          data: null,
          timestamp: 0
        };
        cache.studentLookup.clear();
        
        console.log('Memory store, StudentDevices ve önbellek temizlendi');
        return res.status(200).json({ 
          success: true,
          message: 'Memory store ve cihaz eşleştirmeleri temizlendi'
        });
      }
      else if (cleanStep === 'sheets') {
        const selectedWeek = req.query.week ? parseInt(req.query.week as string) : null;
        
        // Eğer hafta yoksa
        if (!selectedWeek) {
          return res.status(400).json({ 
            success: false,
            error: 'Hafta bilgisi gerekli'
          });
        }
        
        try {
          // İlk olarak StudentDevices sayfasını temizleyelim
          await deviceTracker.clearStudentDevices();
          console.log('StudentDevices sayfası temizlendi');
          
          // Şimdi belirlenen haftayı temizleyelim
          console.log(`${selectedWeek}. hafta için temizleme işlemi başlıyor...`);
          
          // Yanıtı hemen dönelim - işlem arka planda devam edecek
          res.status(200).json({ 
            success: true,
            message: `İşlem başlatıldı. Tamamlanması birkaç dakika sürebilir.`,
            timeout: true
          });
          
          // İşlemi arka planda başlat
          setTimeout(async () => {
            try {
              // Büyük batch size ile daha verimli temizleme yapacak
              const updateCount = await deviceTracker.clearSheetWeek(selectedWeek);
              console.log(`Arka planda ${selectedWeek}. haftada ${updateCount} hücre temizlendi`);
            } catch (bgError) {
              console.error('Arka plan temizleme hatası:', bgError);
            }
          }, 0);
          
          return; // Yanıt zaten gönderildiği için burada keselim
        } catch (error: any) {
          console.error('Google Sheets temizleme hatası:', error);
          if (res.headersSent) {
            console.log('Yanıt zaten gönderildi, hata bilgisi loglanıyor');
            return;
          }
          return res.status(500).json({ 
            success: false,
            error: 'Google Sheets temizlenemedi: ' + (error instanceof Error ? error.message : 'Bilinmeyen hata')
          });
        }
      }
      else {
        return res.status(400).json({ 
          success: false,
          error: 'Geçersiz cleanStep değeri'
        });
      }
    }
    else {
      // Tüm cihaz kayıtlarını temizle
      console.log('Tüm cihaz kayıtları temizleme işlemi başlatıldı');
      
      // 1. Memory store'u temizle
      deviceTracker.clearMemoryStore();
      
      // 2. Google Sheets'teki öğrenci-cihaz eşleştirmelerini temizle
      try {
        await deviceTracker.clearStudentDevices();
      } catch (error) {
        console.error('StudentDevices temizleme hatası:', error);
        // Bu hatayı yutup devam edelim
      }
      
      // 3. Önbelleği temizle
      cache.mainSheet = {
        data: null,
        timestamp: 0
      };
      cache.studentLookup.clear();
      
      console.log('Tüm cihaz kayıtları temizlendi');

      return res.status(200).json({ 
        success: true,
        message: 'Tüm cihaz kayıtları temizlendi'
      });
    }
  } catch (error) {
    console.error('Delete Error:', error);
    return res.status(500).json({ 
      error: 'İşlem sırasında bir hata oluştu'
    });
  }
}