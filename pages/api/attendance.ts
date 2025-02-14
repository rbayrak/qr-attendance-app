import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

type ResponseData = {
  success?: boolean;
  error?: string;
  message?: string;
  blockedStudentId?: string;
  isAlreadyAttended?: boolean;
  debug?: any;
};

interface DeviceAttendanceRecord {
  studentId: string;
  timestamp: number;
  firstStudentId?: string;
  deviceFingerprints: string[];
}

const deviceAttendanceMap = new Map<string, DeviceAttendanceRecord>();

const deepCleanDeviceRecords = (fingerprint: string) => {
  let deletedCount = 0;
  
  deviceAttendanceMap.forEach((record, key) => {
    // Anahtar olarak eşleşenler
    if (key === fingerprint) {
      deviceAttendanceMap.delete(key);
      deletedCount++;
    }
    // Array içinde geçenler
    else if (record.deviceFingerprints.includes(fingerprint)) {
      const updatedFingerprints = record.deviceFingerprints.filter(fp => fp !== fingerprint);
      if (updatedFingerprints.length === 0) {
        deviceAttendanceMap.delete(key);
      } else {
        deviceAttendanceMap.set(key, {
          ...record,
          deviceFingerprints: updatedFingerprints
        });
      }
      deletedCount++;
    }
  });
  
  return deletedCount;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      const { studentId, week, clientIP, deviceFingerprint } = req.body;

      // Validasyonlar
      if (!studentId || !week) {
        return res.status(400).json({ error: 'Öğrenci ID ve hafta bilgisi gerekli' });
      }
      if (!deviceFingerprint) {
        return res.status(400).json({ error: 'Cihaz tanımlayıcısı gerekli' });
      }

      // Günlük timestamp kontrolü
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const existingRecord = deviceAttendanceMap.get(deviceFingerprint);
      
      if (existingRecord) {
        // Aynı gün kontrolü
        if (existingRecord.timestamp >= today.getTime()) {
          const firstStudentId = existingRecord.firstStudentId || existingRecord.studentId;
          
          if (studentId !== firstStudentId) {
            return res.status(403).json({ 
              error: 'Bu cihaz bugün başka bir öğrenci için kullanılmış',
              blockedStudentId: firstStudentId 
            });
          }
        } else {
          // Yeni gün için kayıt güncelle
          deviceAttendanceMap.set(deviceFingerprint, {
            studentId,
            timestamp: Date.now(),
            firstStudentId: studentId,
            deviceFingerprints: [deviceFingerprint]
          });
        }
      } else {
        // İlk kayıt
        deviceAttendanceMap.set(deviceFingerprint, {
          studentId,
          timestamp: Date.now(),
          firstStudentId: studentId,
          deviceFingerprints: [deviceFingerprint]
        });
      }

      // Google Sheets entegrasyonu
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
      
      // Tüm verileri çek
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      });

      const rows = response.data.values || [];
      const studentRowIndex = rows.findIndex(row => row[1] === studentId);
      
      if (studentRowIndex === -1) {
        return res.status(404).json({ error: 'Öğrenci bulunamadı' });
      }

      // Hafta sütunu kontrolü
      const weekColumnIndex = 3 + Number(week) - 1;
      const weekData = rows.map(row => row[weekColumnIndex]);
      
      // Cihaz parmak izi kontrolü
      const existingFingerprint = weekData.find(cell => 
        cell?.includes(`(DF:${deviceFingerprint})`)
      );

      if (existingFingerprint) {
        const existingStudentId = rows.find(row => 
          row[weekColumnIndex]?.includes(`(DF:${deviceFingerprint}`)
        )?.[1];

        if (existingStudentId !== studentId) {
          return res.status(403).json({ 
            error: 'Bu cihaz bu hafta başka bir öğrenci için kullanılmış',
            blockedStudentId: existingStudentId 
          });
        }
        return res.status(200).json({ 
          success: true,
          isAlreadyAttended: true,
          message: 'Bu hafta için yoklama zaten alınmış'
        });
      }

      // Google Sheets güncelleme
      const updateResult = await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${String.fromCharCode(64 + weekColumnIndex)}${studentRowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[`VAR (DF:${deviceFingerprint})`]]
        }
      });

      res.status(200).json({ 
        success: true,
        debug: {
          operationDetails: {
            studentId,
            week,
            deviceFingerprint,
            sheetUpdate: updateResult.data
          }
        }
      });

    } catch (error) {
      console.error('Sunucu hatası:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : 'Bilinmeyen hata',
        debug: process.env.NODE_ENV === 'development' ? error : undefined
      });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const fingerprint = req.query.fingerprint as string;
      
      if (!fingerprint || fingerprint === 'undefined') {
        deviceAttendanceMap.clear();
        return res.status(200).json({ 
          success: true,
          message: 'Tüm cihaz kayıtları temizlendi' 
        });
      }

      const decodedFingerprint = decodeURIComponent(fingerprint);
      const totalDeleted = deepCleanDeviceRecords(decodedFingerprint);
      
      return res.status(totalDeleted > 0 ? 200 : 404).json({
        success: totalDeleted > 0,
        message: totalDeleted > 0 
          ? `${decodedFingerprint} ile ilişkili ${totalDeleted} kayıt silindi`
          : 'Kayıt bulunamadı'
      });

    } catch (error) {
      console.error('Silme hatası:', error);
      res.status(500).json({ 
        error: 'Internal server error',
        debug: process.env.NODE_ENV === 'development' ? error : undefined
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
