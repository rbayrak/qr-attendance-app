'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

const READER_ELEMENT_ID = 'qr-reader-fullscreen';

// html5-qrcode kareyi, video elemanının ekrandaki (CSS) genişliğinde bir
// canvas'a çizip çözer. Telefonda bu ~375px'e düşer ve uzaktaki QR birkaç
// piksele iner. Video'yu 1080px genişlikte yerleştirip ekrana CSS transform
// ile sığdırarak çözünürlüğü korunur (transform, clientWidth'i değiştirmez).
const RENDER_WIDTH = 1080;

const ZOOM_PRESETS = [1, 2, 3];

interface ZoomState {
  min: number;
  max: number;
  value: number;
}

interface FullscreenQrScannerProps {
  // Okunan metni değerlendirir: true dönerse tarama biter, false dönerse
  // (yoklama QR'ı değilse) taramaya devam edilir
  onDecoded: (text: string) => boolean;
  onClose: () => void;
  // message: öğrenciye gösterilecek açıklama, detail: teşhis için ham hata
  onCameraError: (message: string, detail: string) => void;
  // Canlı kamera yerine telefonun kamera uygulamasıyla fotoğraf çekme
  onUsePhoto: () => void;
}

const FullscreenQrScanner: React.FC<FullscreenQrScannerProps> = ({
  onDecoded,
  onClose,
  onCameraError,
  onUsePhoto
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const handledRef = useRef(false);
  const onDecodedRef = useRef(onDecoded);
  const onCameraErrorRef = useRef(onCameraError);
  const [isStarting, setIsStarting] = useState(true);
  const [hint, setHint] = useState('QR kodu çerçevenin içine getirin');
  const [zoom, setZoom] = useState<ZoomState | null>(null);

  onDecodedRef.current = onDecoded;
  onCameraErrorRef.current = onCameraError;

  // Video'yu ekranı tamamen kaplayacak şekilde (object-fit: cover gibi) ölçekle
  const fitStage = () => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    const video = stage?.querySelector('video');
    if (!viewport || !stage || !video) return;

    const width = video.clientWidth;
    const height = video.clientHeight;
    if (!width || !height) return;

    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    const scale = Math.max(viewportWidth / width, viewportHeight / height);
    const offsetX = (viewportWidth - width * scale) / 2;
    const offsetY = (viewportHeight - height * scale) / 2;
    stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };

  useEffect(() => {
    let cancelled = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      // Eski tarayıcılar ve bazı uygulama içi tarayıcılar canlı kamerayı desteklemez
      onCameraErrorRef.current(
        'Bu tarayıcı canlı kamerayı desteklemiyor. "Fotoğraf çekerek okut" seçeneğini kullanın veya sayfayı Safari/Chrome ile açın.',
        'mediaDevices.getUserMedia yok'
      );
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const scanner = new Html5Qrcode(READER_ELEMENT_ID, {
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      useBarCodeDetectorIfSupported: true,
      verbose: false
    });
    scannerRef.current = scanner;

    const startPromise = scanner.start(
      { facingMode: 'environment' },
      {
        fps: 15,
        disableFlip: true,
        videoConstraints: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      },
      (decodedText) => {
        if (handledRef.current) return;
        const accepted = onDecodedRef.current(decodedText);
        if (accepted) {
          handledRef.current = true;
        } else {
          setHint('⚠️ Bu QR yoklama kodu değil. Öğretmenin yansıttığı QR kodu okutun.');
        }
      },
      () => {
        // Karede QR bulunamadı - normal, sessizce devam et
      }
    );

    startPromise
      .then(() => {
        if (cancelled) return;
        setIsStarting(false);

        const video = stageRef.current?.querySelector('video');
        if (video) {
          video.addEventListener('loadedmetadata', fitStage);
          video.addEventListener('resize', fitStage);
        }
        fitStage();

        try {
          const zoomFeature = scanner.getRunningTrackCameraCapabilities().zoomFeature();
          if (zoomFeature.isSupported()) {
            const min = zoomFeature.min();
            setZoom({ min, max: zoomFeature.max(), value: zoomFeature.value() ?? min });
          }
        } catch {
          // Yakınlaştırma desteklenmiyor
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const detail = String((error as Error)?.message || error || '');
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
        if (/NotAllowed|Permission/i.test(detail)) {
          // İzin reddedilince tarayıcı bunu hatırlar: "QR Tara"ya tekrar basmak aynı
          // hatayı verir. En hızlı yol izin gerektirmeyen fotoğraf seçeneği.
          const photoTip = 'En kolayı: aşağıdaki turuncu "📸 Fotoğraf çekerek okut" düğmesine basın. ';
          onCameraErrorRef.current(
            /dismissed/i.test(detail)
              ? 'Kamera izni sorusu yanıtlanmadan kapandı. ' + photoTip +
                'Canlı kamera için "Canlı kamerayı tekrar dene"ye basıp soruda "İzin ver"i seçin.'
              : isIOS
                ? 'Kamera izni verilmedi. ' + photoTip +
                  'Canlı kamera için sayfayı yenileyin, "QR Tara"ya basın ve soruda "İzin Ver"i seçin ' +
                  '(soru gelmezse adres çubuğundaki "aA" > Web Sitesi Ayarları > Kamera > İzin Ver).'
                : 'Kamera izni verilmedi. ' + photoTip +
                  'Canlı kamera için adres çubuğundaki kilit/ayar simgesi > İzinler > Kamera > İzin ver yapıp sayfayı yenileyin.',
            detail
          );
        } else if (/NotFound|Overconstrained|Requested device not found/i.test(detail)) {
          onCameraErrorRef.current('Arka kamera bulunamadı. "Fotoğraf çekerek okut" seçeneğini kullanın.', detail);
        } else if (/NotReadable|TrackStart|in use|Could not start/i.test(detail)) {
          onCameraErrorRef.current(
            'Kamera başka bir uygulama tarafından kullanılıyor olabilir. Diğer uygulamaları kapatıp tekrar deneyin ya da "Fotoğraf çekerek okut" seçeneğini kullanın.',
            detail
          );
        } else {
          onCameraErrorRef.current('Kamera başlatılamadı. "Fotoğraf çekerek okut" seçeneğini kullanın.', detail);
        }
      });

    window.addEventListener('resize', fitStage);
    window.addEventListener('orientationchange', fitStage);

    return () => {
      cancelled = true;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('resize', fitStage);
      window.removeEventListener('orientationchange', fitStage);
      // start() henüz bitmemiş olabilir; bittikten sonra kamerayı kapat
      startPromise
        .then(() => scanner.stop())
        .catch(() => undefined)
        .finally(() => {
          try {
            scanner.clear();
          } catch {
            // zaten temizlenmiş
          }
        });
    };
  }, []);

  const applyZoom = async (target: number) => {
    const scanner = scannerRef.current;
    if (!scanner || !zoom) return;
    const value = Math.min(Math.max(target, zoom.min), zoom.max);
    try {
      await scanner.getRunningTrackCameraCapabilities().zoomFeature().apply(value);
      setZoom({ ...zoom, value });
    } catch {
      // Yakınlaştırma uygulanamadı
    }
  };

  return (
    <div
      ref={viewportRef}
      className="fixed inset-0 z-[1000] bg-black overflow-hidden"
      role="dialog"
      aria-label="QR kod tarayıcı"
    >
      <div
        ref={stageRef}
        className="absolute left-0 top-0"
        style={{ width: RENDER_WIDTH, transformOrigin: '0 0' }}
      >
        <div id={READER_ELEMENT_ID} style={{ width: RENDER_WIDTH }} />
      </div>

      {/* Nişan çerçevesi (yalnızca görsel; tüm kare taranır) */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className="rounded-2xl border-4 border-white/90"
          style={{ width: '72vmin', height: '72vmin', boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)' }}
        />
      </div>

      <div className="absolute top-0 left-0 right-0 flex items-center justify-between p-4 bg-gradient-to-b from-black/70 to-transparent">
        <span className="text-white font-semibold text-lg">QR Kodu Okutun</span>
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-full bg-white/90 text-gray-900 font-semibold text-base"
        >
          ✕ Kapat
        </button>
      </div>

      {isStarting && (
        <div className="absolute inset-0 flex items-center justify-center text-white text-lg">
          📷 Kamera açılıyor...
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 space-y-3 bg-gradient-to-t from-black/80 to-transparent">
        {zoom && zoom.max > zoom.min && (
          <div className="flex justify-center gap-3">
            {ZOOM_PRESETS.filter(preset => preset <= zoom.max).map(preset => (
              <button
                key={preset}
                onClick={() => applyZoom(preset)}
                className={`w-14 h-14 rounded-full text-base font-bold ${
                  Math.abs(zoom.value - preset) < 0.05
                    ? 'bg-yellow-400 text-gray-900'
                    : 'bg-white/25 text-white'
                }`}
              >
                {preset}x
              </button>
            ))}
          </div>
        )}
        <p className="text-center text-white text-base">{hint}</p>
        {zoom && zoom.max > zoom.min && (
          <p className="text-center text-white/70 text-sm">Uzaktaysanız yakınlaştırmayı (2x / 3x) kullanın</p>
        )}
        <div className="flex justify-center">
          <button
            onClick={onUsePhoto}
            className="px-4 py-2 rounded-full bg-white/20 text-white text-sm"
          >
            📸 Okumuyor mu? Fotoğraf çekerek okut
          </button>
        </div>
      </div>
    </div>
  );
};

export default FullscreenQrScanner;
