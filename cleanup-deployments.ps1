# Eski deployment'ları temizleme scripti
# NOT: Bu script 2 saatten eski tüm deployment'ları siler

Write-Host "🗑️  Eski deployment'lar temizleniyor..." -ForegroundColor Yellow

# Bugünden önceki deployment'ları sil
$cutoffDate = (Get-Date).AddHours(-2)

# Vercel deployment listesini al ve eski olanları sil
$deployments = vercel ls --format json | ConvertFrom-Json

foreach ($deployment in $deployments.deployments) {
    $age = $deployment.age
    
    # Sadece 2 saatten eski olanları sil
    if ($age -match '(\d+)d' -or $age -match '([3-9]|[1-9]\d+)h') {
        $url = $deployment.url
        Write-Host "Siliniyor: $url (Age: $age)" -ForegroundColor Red
        vercel remove $url --yes
        Start-Sleep -Seconds 1  # Rate limiting için bekleme
    }
}

Write-Host "✅ Temizleme tamamlandı!" -ForegroundColor Green
