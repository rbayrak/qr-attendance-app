# QR Kod Yoklama Sistemi - Troubleshooting Guide

## ✅ Google OAuth Hatası Çözümü

### Sorun
```
İstek ayrıntıları: redirect_uri=storagerelay://https/qr-attendance-app-ramazan-bayraks-projects.vercel.app
```

### Çözüm Adımları

#### 1. Google Cloud Console Ayarları

**a) Credentials Sayfası:**
- https://console.cloud.google.com → APIs & Services → Credentials
- OAuth 2.0 Client ID'nizi düzenleyin (1076048696975-... ile başlayan)

**b) Authorized JavaScript origins ekleyin:**
```
https://qr-attendance-app-ramazan-bayraks-projects.vercel.app
http://localhost:3000
```

**c) Authorized redirect URIs ekleyin:**
```
https://qr-attendance-app-ramazan-bayraks-projects.vercel.app
https://qr-attendance-app-ramazan-bayraks-projects.vercel.app/__/auth/handler
http://localhost:3000
http://localhost:3000/__/auth/handler
```

**d) SAVE butonuna tıklayın**

#### 2. OAuth Consent Screen Kontrolü

**APIs & Services → OAuth consent screen:**
- Publishing status: "In production" veya "Testing" olmalı
- Eğer "Testing" modundaysa, kendinizi Test Users listesine ekleyin
- App name, User support email ve Developer contact bilgilerinin dolu olduğundan emin olun

#### 3. Scopes Kontrolü

**OAuth consent screen → Scopes:**
- Şu scope'un ekli olduğundan emin olun:
  ```
  https://www.googleapis.com/auth/spreadsheets
  ```

#### 4. Vercel Environment Variables

**Vercel Dashboard → Your Project → Settings → Environment Variables:**

Şu değişkenlerin AYNI değerlerde olduğundan emin olun:

```env
# Google OAuth (Client-side)
NEXT_PUBLIC_GOOGLE_CLIENT_ID=1076048696975-0ong149iuil85c5tnddv3lkaknkkc12g.apps.googleusercontent.com
NEXT_PUBLIC_GOOGLE_API_KEY=your_api_key_here

# Google Sheets API (Backend)
SPREADSHEET_ID=your_sheet_id_here
GOOGLE_PROJECT_ID=your_project_id
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_CLIENT_EMAIL=your_service_account@project.iam.gserviceaccount.com
```

**ÖNEMLİ:** Environment değişkenleri her üç environment için de ayarlanmalı:
- ✅ Production
- ✅ Preview  
- ✅ Development

#### 5. Deploy ve Cache Temizleme

**Vercel Dashboard'da:**
1. Deployments sekmesine gidin
2. Son deployment'ın yanındaki "..." menüsüne tıklayın
3. "Redeploy" seçeneğini seçin
4. "Use existing Build Cache" seçeneğini KAPATIN
5. Deploy butonuna tıklayın

#### 6. Tarayıcı Önbelleğini Temizleme

**Chrome/Edge:**
- F12 → Application → Storage → Clear site data
- Veya: Settings → Privacy and security → Clear browsing data

**Firefox:**
- F12 → Storage → Cookies → Siteyi sil

#### 7. Test

1. Yeni bir incognito/private window açın
2. https://qr-attendance-app-ramazan-bayraks-projects.vercel.app adresine gidin
3. Öğretmen moduna geçin (şifre: Vercel'deki TEACHER_PASSWORD ortam değişkeni)
4. Google yetkilendirme popup'ını bekleyin
5. Google hesabınızı seçin ve izinleri onaylayın

### Hala Çalışmıyorsa

#### Console Loglarını Kontrol Edin

**Tarayıcıda:**
- F12 → Console
- Şu logları arayın:
  ```
  🔐 Google Auth başlatılıyor...
  📋 Client ID: ...
  ✅ Google Identity Services yüklendi
  🔄 Token isteniyor...
  ✅ Access token alındı
  ```

#### Vercel Logs'u İnceleyin

**Vercel Dashboard:**
- Deployments → Son deployment → View Function Logs
- Hata mesajlarını not alın

### Olası Hatalar ve Çözümleri

| Hata | Çözüm |
|------|-------|
| "Token hatası: popup_closed_by_user" | Kullanıcı popup'ı kapattı, yeniden deneyin |
| "Google Identity Services yüklenemedi" | Sayfayı yenileyin, internet bağlantınızı kontrol edin |
| "Client ID bulunamadı" | NEXT_PUBLIC_GOOGLE_CLIENT_ID environment değişkenini kontrol edin |
| "redirect_uri_mismatch" | Google Cloud Console'da redirect URI'leri kontrol edin |
| "Access blocked" | OAuth consent screen'i production'a alın veya test users ekleyin |

### İletişim

Sorun devam ederse:
1. Console loglarını kaydedin
2. Vercel deployment loglarını kaydedin
3. Google Cloud Console ayarlarının ekran görüntüsünü alın
4. Geliştirici ile paylaşın

---

**Son Güncelleme:** 2025-09-29
**Versiyon:** 1.0
