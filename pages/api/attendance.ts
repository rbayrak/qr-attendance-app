// pages/api/attendance.ts

import { NextApiRequest, NextApiResponse } from 'next';
import { ResponseData } from '@/types/types';
import { deviceTracker } from '@/utils/deviceTracker';
import { google } from 'googleapis';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method === 'POST') {
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

      // 2. Device Tracker kontrolü
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

      // 3. Google Sheets işlemleri
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

      // 4. Verileri çek
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'A:Z',
      });

      const rows = response.data.values;
      if (!rows) {
        return res.status(404).json({ error: 'Veri bulunamadı' });
      }

      // 5. Öğrenciyi bul
      const studentRowIndex = rows.findIndex(row => row[1] === studentId);
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

      // 9. Yoklamayı kaydet
      // 9. Yoklamayı kaydet
      const updateResult = await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[`VAR (DF:${deviceFingerprint}) (HW:${hardwareSignature}) (DATE:${Date.now()})`]]
        }
      });

      // 10. Başarılı yanıt
      res.status(200).json({ 
        success: true,
        isAlreadyAttended,
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
  else if (req.method === 'DELETE') {
    const { fingerprint } = req.query;

    try {
      if (fingerprint) {
        // 1. Google Sheets'ten fingerprint'i temizle
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
              await sheets.spreadsheets.values.update({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: range,
                valueInputOption: 'RAW',
                requestBody: {
                  values: [['VAR']]
                }
              });
            }
          }
        }

        if (!fingerprintFound) {
          return res.status(404).json({ error: 'Fingerprint bulunamadı' });
        }

        return res.status(200).json({ 
          success: true,
          message: `${fingerprint} fingerprint'i silindi`
        });
      }

      return res.status(200).json({ 
        success: true,
        message: 'Tüm cihaz kayıtları temizlendi'
      });
    } catch (error) {
      console.error('Delete Error:', error);
      return res.status(500).json({ 
        error: 'İşlem sırasında bir hata oluştu'
      });
    }
  }
  else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}