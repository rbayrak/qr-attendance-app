import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

type ResponseData = {
  success?: boolean;
  error?: string;
  message?: string;
  blockedStudentId?: string;
  isAlreadyAttended?: boolean;
};

interface DeviceAttendanceRecord {
  studentId: string;
  timestamp: number;
  firstStudentId?: string;
  deviceFingerprints: string[];
}

const deviceAttendanceMap = new Map<string, DeviceAttendanceRecord>();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      const { studentId, week, clientIP, deviceFingerprint } = req.body;
      
      if (!studentId || !week) {
        return res.status(400).json({ error: 'Öğrenci ID ve hafta bilgisi gerekli' });
      }

      // Cihaz kontrol mantığı
      const today = new Date().setHours(0,0,0,0);
      const existingRecord = deviceAttendanceMap.get(deviceFingerprint);

      if (existingRecord && existingRecord.timestamp >= today) {
        if (studentId !== (existingRecord.firstStudentId || existingRecord.studentId)) {
          return res.status(403).json({
            error: 'Bu cihaz bugün başka bir öğrenci için kullanılmış',
            blockedStudentId: existingRecord.firstStudentId
          });
        }
      } else {
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
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      });

      const rows = response.data.values || [];
      const studentRowIndex = rows.findIndex(row => row[1] === studentId);
      
      if (studentRowIndex === -1) {
        return res.status(404).json({ error: 'Öğrenci bulunamadı' });
      }

      // Hafta sütunu ve kayıt işlemleri
      const weekColumn = 3 + Number(week) - 1;
      const weekData = rows.map(row => row[weekColumn]);
      const hasExistingRecord = weekData.some(cell => cell?.includes(`DF:${deviceFingerprint}`));

      if (hasExistingRecord) {
        return res.status(200).json({ 
          success: true,
          isAlreadyAttended: true,
          message: 'Bu hafta için yoklama zaten alınmış'
        });
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${String.fromCharCode(64 + weekColumn)}${studentRowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[`VAR (DF:${deviceFingerprint})`]] }
      });

      res.status(200).json({ success: true });

    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const fingerprint = req.query.fingerprint as string;
      
      if (!fingerprint || fingerprint === 'undefined') {
        deviceAttendanceMap.clear();
        return res.status(200).json({ 
          success: true,
          message: 'Tüm kayıtlar temizlendi' 
        });
      }

      const deleted = deviceAttendanceMap.delete(fingerprint);
      return res.status(deleted ? 200 : 404).json({
        success: deleted,
        message: deleted 
          ? `${fingerprint} cihaz kaydı silindi`
          : 'Kayıt bulunamadı'
      });

    } catch (error) {
      console.error('Silme hatası:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
