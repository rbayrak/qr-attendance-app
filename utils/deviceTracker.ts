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
      // 1. Bugünün başlangıç timestamp'i
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // 2. Aynı gün içinde kullanılmış cihaz kontrolü
      for (const [_, record] of this.memoryStore) {
        const recordDate = new Date(record.lastUsedDate);
        if (recordDate >= today) {
          // 2.1 Fingerprint kontrolü
          if (record.fingerprints.includes(deviceFingerprint)) {
            if (record.studentId !== studentId) {
              return {
                isAllowed: false,
                blockedReason: `Bu cihaz bugün ${record.studentId} numaralı öğrenci için kullanılmış`
              };
            }
          }

          // 2.2 Hardware signature kontrolü
          if (record.hardwareSignature === hardwareSignature) {
            if (record.studentId !== studentId) {
              return {
                isAllowed: false,
                blockedReason: `Bu cihaz bugün başka bir öğrenci için kullanılmış`
              };
            }
          }
        }
      }

      // 3. Yeni kayıt oluştur veya güncelle
      const existingRecord = this.memoryStore.get(hardwareSignature);
      
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
      // 1. Google Sheets kontrolü
      const sheetsCheck = await this.checkGoogleSheets(fingerprint, studentId);
      if (!sheetsCheck.isValid) {
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

  private async checkGoogleSheets(
    fingerprint: string,
    studentId: string
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

      // Fingerprint'i sheets'te ara
      for (let i = 1; i < rows.length; i++) {
        for (let j = 3; j < rows[i].length; j++) {
          const cell = rows[i][j];
          if (cell && cell.includes(`(DF:${fingerprint})`)) {
            if (rows[i][1] !== studentId) {
              return {
                isValid: false,
                error: 'Bu cihaz başka bir öğrenci için kullanılmış',
                blockedStudentId: rows[i][1]
              };
            }
          }
        }
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
}

// Singleton instance'ı export et
export const deviceTracker = DeviceTracker.getInstance();