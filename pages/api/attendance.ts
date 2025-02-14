import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

type ResponseData = {
  success?: boolean;
  error?: string;
  message?: string;  // Add this line
  debug?: any;
  blockedStudentId?: string;
  isAlreadyAttended?: boolean;
};

interface DeviceAttendanceRecord {
  studentId: string;
  timestamp: number;
  firstStudentId?: string;
  deviceFingerprints: string[];
}

// Cihaz bazlı yoklama kayıtları
const deviceAttendanceMap = new Map<string, DeviceAttendanceRecord>();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method === 'POST') {

    try {
      const { studentId, week, clientIP, deviceFingerprint } = req.body;

      if (!studentId || !week) {
        return res.status(400).json({ error: 'Öğrenci ID ve hafta bilgisi gerekli' });
      }

      // Cihaz parmak izi kontrolü
      if (!deviceFingerprint) {
        return res.status(400).json({ error: 'Cihaz tanımlayıcısı gerekli' });
      }

      // Bugünün başlangıç timestamp'i
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      // Mevcut cihaz kaydını kontrol et
      const existingAttendance = deviceAttendanceMap.get(deviceFingerprint);
      
      if (existingAttendance) {
        // Aynı gün kontrolü
        if (existingAttendance.timestamp >= today.getTime()) {
          const firstStudentId = existingAttendance.firstStudentId || existingAttendance.studentId;
          
          // Farklı öğrenci kontrolü
          if (studentId !== firstStudentId) {
            return res.status(403).json({ 
              error: 'Bu cihaz bugün başka bir öğrenci için kullanılmış',
              blockedStudentId: firstStudentId 
            });
          }
        } else {
          // Günü geçmiş kayıt, güncelle
          deviceAttendanceMap.set(deviceFingerprint, {
            studentId,
            timestamp: Date.now(),
            firstStudentId: studentId,
            deviceFingerprints: [deviceFingerprint]
          });
        }
      } else {
        // İlk kez kayıt
        deviceAttendanceMap.set(deviceFingerprint, {
          studentId,
          timestamp: Date.now(),
          firstStudentId: studentId,
          deviceFingerprints: [deviceFingerprint]
        });
      }

      // Google Sheets yetkilendirmesi
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

      const rows = response.data.values;
      if (!rows) {
        return res.status(404).json({ error: 'Veri bulunamadı' });
      }

      // Öğrenciyi bul ve satır numarasını al
      const studentRowIndex = rows.findIndex(row => row[1] === studentId);
      if (studentRowIndex === -1) {
        return res.status(404).json({ error: 'Öğrenci bulunamadı' });
      }

      // Hafta sütunu kontrolü
      const weekColumnIndex = 3 + Number(week) - 1; // D sütunundan başlayarak
      const weekData = rows.map(row => row[weekColumnIndex]);
      
      // Cihaz parmak izi kontrolü
      const deviceFingerprintCheck = weekData.find(cell => 
        cell && 
        cell.includes(`(DF:${deviceFingerprint})`)
      );
      
      if (deviceFingerprintCheck) {
        // Bu cihaz parmak izi zaten kullanılmışsa
        const existingStudentId = rows[rows.findIndex(row => 
          row[weekColumnIndex] && 
          row[weekColumnIndex].includes(`(DF:${deviceFingerprint})`)
        )][1];

        // Farklı bir öğrenci için kullanılmışsa engelle
        if (existingStudentId !== studentId) {
          return res.status(403).json({ 
            error: 'Bu cihaz bu hafta başka bir öğrenci için kullanılmış',
            blockedStudentId: existingStudentId 
          });
        }
      }
      
      // Gerçek satır numarası
      const studentRow = studentRowIndex + 1;

      if (week < 1 || week > 16) {
        return res.status(400).json({ error: 'Geçersiz hafta numarası' });
      }

      // Hafta sütununu belirle
      const weekColumn = String.fromCharCode(68 + Number(week) - 1);
      const range = `${weekColumn}${studentRow}`;

      // Mevcut hafta verilerini kontrol et ve öğrencinin zaten yoklaması var mı diye bak
      const isAlreadyAttended = rows[studentRowIndex][weekColumnIndex] && 
                              rows[studentRowIndex][weekColumnIndex].includes('VAR');

      // Yoklamayı kaydet (cihaz parmak izi ile)
      const updateResult = await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[`VAR (DF:${deviceFingerprint})`]]
        }
      });

      // Başarılı yanıt
      res.status(200).json({ 
        success: true,
        isAlreadyAttended: isAlreadyAttended,
        debug: {
          operationDetails: {
            ogrenciNo: studentId,
            bulunanSatir: studentRow,
            sutun: weekColumn,
            aralik: range,
            weekNumber: week,
            deviceFingerprint: deviceFingerprint
          },
          updateResult: updateResult.data
        }
      });

    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        debug: 'debugInfo'
      });
    }
  }

  else if (req.method === 'DELETE') {
    const fingerprint = req.query.fingerprint as string;
    
    if (fingerprint && fingerprint !== 'undefined') {
      // Belirli bir fingerprint'i sil
      const deleted = deviceAttendanceMap.delete(fingerprint);
      return res.status(deleted ? 200 : 404).json({ 
        success: deleted,
        message: deleted 
          ? `${fingerprint} cihaz kaydı silindi` 
          : 'Cihaz kaydı bulunamadı'
      });
    } else {
      // Tüm kayıtları temizle
      deviceAttendanceMap.clear();
      return res.status(200).json({ 
        success: true,
        message: 'Tüm cihaz kayıtları temizlendi'
      });
    }
  }
  
}

