// pages/api/job-status.ts
import { NextApiRequest, NextApiResponse } from 'next';
import { deviceTracker } from '@/utils/deviceTracker';
import { google } from 'googleapis';

// İşlem durumlarını takip etmek için basit bir state deposu
// Not: Bu depo sunucu yeniden başlatıldığında sıfırlanır
const progressStore: Record<string, {
  week: number;
  totalCells: number;
  processedCells: number;
  startTime: number;
  lastUpdate: number;
  isCompleted: boolean;
  error?: string;
}> = {};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { jobId, week, action } = req.query;
  
  // jobId kontrolü
  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ error: 'Geçerli bir jobId gerekli' });
  }
  
  // Yeni iş başlatma
  if (action === 'start') {
    const weekNum = week ? parseInt(week as string) : null;
    
    if (!weekNum || isNaN(weekNum) || weekNum < 1 || weekNum > 16) {
      return res.status(400).json({ error: 'Geçerli bir hafta numarası (1-16) gerekli' });
    }
    
    try {
      // Temizlenecek hücre sayısını hesapla
      const cellCount = await countCellsToClean(weekNum);
      
      // İş kaydını oluştur
      progressStore[jobId] = {
        week: weekNum,
        totalCells: cellCount,
        processedCells: 0,
        startTime: Date.now(),
        lastUpdate: Date.now(),
        isCompleted: false
      };
      
      return res.status(200).json({
        jobId,
        totalCells: cellCount,
        message: `${weekNum}. hafta için temizleme işlemi başlatıldı`,
        progress: 0
      });
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Bilinmeyen hata'
      });
    }
  }
  
  // İş ilerlemesi (tek batch işleme)
  else if (action === 'process') {
    // İş kaydı kontrolü
    if (!progressStore[jobId]) {
      return res.status(404).json({ error: 'İş kaydı bulunamadı' });
    }
    
    const job = progressStore[jobId];
    
    // İş zaten tamamlanmış mı?
    if (job.isCompleted) {
      return res.status(200).json({
        completed: true,
        totalCells: job.totalCells,
        processedCells: job.processedCells,
        progress: 100,
        elapsedTime: Date.now() - job.startTime
      });
    }
    
    try {
      // Bir batch işle (her seferinde maksimum 50 hücre)
      const BATCH_SIZE = 50;
      const result = await processBatch(job.week, job.processedCells, BATCH_SIZE);
      
      // İşlem kaydını güncelle
      job.processedCells += result.processedCount;
      job.lastUpdate = Date.now();
      
      // İşlem tamamlandı mı?
      if (job.processedCells >= job.totalCells || result.isCompleted) {
        job.isCompleted = true;
      }
      
      // İlerleme yüzdesini hesapla
      const progress = job.totalCells > 0 
        ? Math.min(Math.round((job.processedCells / job.totalCells) * 100), 100)
        : 100;
      
      return res.status(200).json({
        completed: job.isCompleted,
        totalCells: job.totalCells,
        processedCells: job.processedCells,
        progress: progress,
        elapsedTime: Date.now() - job.startTime,
        nextOffset: job.processedCells
      });
    } catch (error) {
      // Hata durumunda iş bilgilerini güncelle
      job.error = error instanceof Error ? error.message : 'Bilinmeyen hata';
      
      return res.status(500).json({
        error: job.error,
        jobId
      });
    }
  }
  
  // İş durumu sorgulama
  else {
    // İş kaydı var mı kontrolü
    if (!progressStore[jobId]) {
      return res.status(404).json({ error: 'İş kaydı bulunamadı' });
    }
    
    const job = progressStore[jobId];
    
    // İlerleme yüzdesini hesapla
    const progress = job.totalCells > 0 
      ? Math.min(Math.round((job.processedCells / job.totalCells) * 100), 100)
      : 0;
    
    // 2 saatten eski işleri otomatik temizle
    if (Date.now() - job.startTime > 2 * 60 * 60 * 1000) {
      delete progressStore[jobId];
      return res.status(404).json({ error: 'İş süresi dolmuş' });
    }
    
    // Güncel durum bilgilerini dön
    return res.status(200).json({
      completed: job.isCompleted,
      inProgress: !job.isCompleted,
      totalCells: job.totalCells,
      processedCells: job.processedCells,
      progress: progress,
      elapsedTime: Date.now() - job.startTime,
      error: job.error,
      week: job.week
    });
  }
}

// Belirli bir haftada temizlenecek hücre sayısını hesapla
async function countCellsToClean(weekNumber: number): Promise<number> {
  try {
    // Google Sheets'ten veri çekme
    const rows = await deviceTracker.getMainSheetData(true);
    if (!rows || rows.length === 0) return 0;
    
    const weekColumnIndex = 3 + (weekNumber - 1);
    let count = 0;
    
    // Hücreleri sayma
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i]) continue;
      
      if (weekColumnIndex < rows[i].length) {
        const cell = rows[i][weekColumnIndex];
        
        if (cell && (cell.includes('(DF:') || cell.includes('(HW:') || cell.includes('(DATE:'))) {
          count++;
        }
      }
    }
    
    return count;
  } catch (error) {
    console.error('Hücre sayma hatası:', error);
    return 0;
  }
}

// Bir batch hücreyi temizleme
async function processBatch(
  weekNumber: number,
  offset: number,
  limit: number
): Promise<{ processedCount: number; isCompleted: boolean }> {
  try {
    // Google Sheets'ten veri çekme
    const rows = await deviceTracker.getMainSheetData();
    if (!rows || rows.length === 0) {
      return { processedCount: 0, isCompleted: true };
    }
    
    const weekColumnIndex = 3 + (weekNumber - 1);
    const columnLetter = String.fromCharCode(65 + weekColumnIndex);
    
    // Temizlenecek hücreleri bul
    const cellsToClean = [];
    let processedCount = 0;
    let foundCells = 0;
    
    // Veri setinden temizlenecek hücreleri seç
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i]) continue;
      
      if (weekColumnIndex < rows[i].length) {
        const cell = rows[i][weekColumnIndex];
        
        if (cell && (cell.includes('(DF:') || cell.includes('(HW:') || cell.includes('(DATE:'))) {
          // Offset'ten sonraki hücreleri işle
          if (foundCells >= offset) {
            cellsToClean.push({
              rowIndex: i,
              range: `${columnLetter}${i + 1}`
            });
            
            processedCount++;
            
            // Limit dolduğunda işlemi durdur
            if (processedCount >= limit) break;
          }
          
          foundCells++;
        }
      }
    }
    
    // İşlenecek hücre yoksa tamamlandı olarak işaretle
    if (cellsToClean.length === 0) {
      return { processedCount: 0, isCompleted: true };
    }
    
    // Google Sheets API ile hücreleri temizle
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    
    // ValueRange nesnelerini oluştur
    const ranges = cellsToClean.map(cell => `${process.env.SPREADSHEET_ID}!${cell.range}`);
    const data = ranges.map(range => ({
      range,
      values: [['VAR']]
    }));
    
    // Tek bir API çağrısında tüm hücreleri güncelle
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data
      }
    });
    
    // İşlem tamamlandı mı?
    const isCompleted = foundCells <= offset + processedCount;
    
    return {
      processedCount,
      isCompleted
    };
  } catch (error) {
    console.error('Batch işleme hatası:', error);
    throw error;
  }
}

// Google Auth yardımcı fonksiyonu
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