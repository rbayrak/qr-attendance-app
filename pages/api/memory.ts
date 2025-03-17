// pages/api/memory.ts

import { NextApiRequest, NextApiResponse } from 'next';
import { deviceTracker } from '@/utils/deviceTracker';
import { google } from 'googleapis';

// API istek kuyruğu
interface QueueItem {
  req: NextApiRequest;
  res: NextApiResponse;
  timestamp: number;
}

// Kuyruk yapısı
let processingQueue: boolean = false;
let requestQueue: QueueItem[] = [];

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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'DELETE') {
    // İsteği kuyruğa ekle
    requestQueue.push({
      req,
      res,
      timestamp: Date.now()
    });
    
    // Kuyruk işlenmiyorsa başlat
    if (!processingQueue) {
      processQueue();
    }
  } else {
    res.status(405).json({ error: 'Method Not Allowed' });
  }
}

// İstek kuyruğunu işleyen fonksiyon
async function processQueue() {
  processingQueue = true;
  
  while (requestQueue.length > 0) {
    const { req, res } = requestQueue.shift()!;
    
    try {
      await processMemoryCleanup(req, res);
    } catch (error) {
      console.error('Queue processing error:', error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Bilinmeyen hata'
      });
    }
    
    // API rate limit aşımını önlemek için küçük bir bekleme
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  processingQueue = false;
}

// Asıl temizleme işlemi
async function processMemoryCleanup(req: NextApiRequest, res: NextApiResponse) {
  try {
    console.log('Cihaz kayıtları temizleme işlemi başlatıldı');
    
    // 1. memoryStore'u temizle
    deviceTracker.clearMemoryStore();
    
    // 2. Google Sheets'teki StudentDevices sayfasını temizle
    await deviceTracker.clearStudentDevices();
    
    // 3. Ana yoklama sayfasındaki cihaz bilgilerini temizle
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
    
    // Yoklama sayfasındaki tüm verileri getir
    const response = await retryableOperation(() => 
      sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      })
    );
    
    const rows = response.data.values;
    if (rows) {
      // Toplu güncelleme için batch isteğini hazırla
      const batchRequests = [];
      const batchSize = 20; // Her batch'te 20 hücre güncelle
      let currentBatch = [];
      
      // Tüm hücreleri kontrol et
      for (let i = 0; i < rows.length; i++) {
        for (let j = 3; j < rows[i].length; j++) {
          const cell = rows[i][j];
          if (cell && (cell.includes('(DF:') || cell.includes('(HW:') || cell.includes('(DATE:'))) {
            const range = `${String.fromCharCode(65 + j)}${i + 1}`;
            
            // Güncelleme isteğini batch'e ekle
            currentBatch.push({
              range: range,
              values: [['VAR']]
            });
            
            // Batch dolunca işle ve yeni batch başlat
            if (currentBatch.length >= batchSize) {
              batchRequests.push([...currentBatch]);
              currentBatch = [];
            }
          }
        }
      }
      
      // Kalan hücreler için son batch'i ekle
      if (currentBatch.length > 0) {
        batchRequests.push(currentBatch);
      }
      
      // Tüm batch'leri işle
      for (const batch of batchRequests) {
        await retryableOperation(() => 
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: process.env.SPREADSHEET_ID,
            requestBody: {
              valueInputOption: 'RAW',
              data: batch
            }
          })
        );
        
        // Batch'ler arasında kısa bir bekleme
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    res.status(200).json({ 
      success: true, 
      message: 'Tüm cihaz kayıtları başarıyla temizlendi' 
    });
  } catch (error) {
    console.error('Memory temizleme hatası:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Bilinmeyen hata' 
    });
  }
}