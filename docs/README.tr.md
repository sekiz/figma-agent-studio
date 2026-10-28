# figma-agent-studio (Türkçe)

**MCP ajanlarıyla (Claude Code, Cursor ve diğerleri) Figma kanvasını yöneten, yerelde çalışan açık kaynak bir DesignOps motoru.**

Masaüstü ekranını seçip ajana söylediğinizde, platform kurallarına uygun **iOS**, **Android (Material 3)**, **Smart TV (10-foot UI)** ve **Tablet** versiyonlarını üretir. Ekranları **RTL'e (Arapça/İbranice)** aynalar, **Design System'e göre denetler** ve kanvasa **geliştirici handoff'u** yazar. Bunları yaparken sizin komponentlerinizi ve token'larınızı kullanır. Bir komponent eksikse kafasına göre kutu çizmez; fuşya bir bayrak açar ve size sorar.

> **Durum: 0.3 (alfa).** Motorlar, köprü, MCP sunucusu ve plugin'in plan uygulayıcısı 177 otomatik testle doğrulandı (Figma Plugin API'sinin katı bir sahte sürümü dahil). Plugin henüz gerçek Figma masaüstü uygulamasında geniş kapsamlı test edilmedi; farklı davranan bir şey görürseniz lütfen issue açın.

## Kurulum (yaklaşık 60 saniye)

1. **MCP sunucusunu ekleyin.**
   - Claude Code: `claude mcp add figma-studio -- npx -y @figma-studio/mcp-server`
   - Cursor: `~/.cursor/mcp.json` → `{"mcpServers":{"figma-studio":{"command":"npx","args":["-y","@figma-studio/mcp-server"]}}}`
2. **Plugin'i yükleyin.** [Releases](https://github.com/sekiz/figma-agent-studio/releases) sayfasından `agent-studio-figma-plugin-<sürüm>.zip` dosyasını indirip açın. Figma masaüstü uygulamasında *Plugins → Development → Import plugin from manifest…* ile `manifest.json` dosyasını seçin. Build gerekmez.
   - Elinizde tasarım dosyası yoksa plugin penceresindeki **Create demo screen + design system** butonu örnek bir ekran, token'lar ve iOS/Android navigasyon komponentleri oluşturur.
3. **Eşleştirin.** Plugin `K7QM-2XPA` gibi bir kod gösterir. Ajana şunu yazın: *"K7QM-2XPA koduyla Figma'ya bağlan, seçili ekranı iOS, Android ve TV için uyarla."*

## Modüller

| Araç | Ne yapar |
|---|---|
| `figma_transpose_surface` | Auto-Layout'u yeniden akıtır. Grid'leri mobilde tek kolona, tablette iki kolona, TV'de D-pad karuseline çevirir. Safe area ekler (Dynamic Island 59pt, Home Indicator 34pt, M3 barları, TV için 80px overscan). Navigasyonu DS komponentleriyle değiştirir. |
| `figma_resolve_missing_component` | Eksik komponent protokolü: **A** token'lardan Master Component üret, **B** en yakın varyantı uyarla, **C** wireframe bırak. |
| `figma_mirror_rtl` | Satırları ters çevirir ve hizalamayı çevirir, padding'leri takas eder, yönlü ikonları flip eder. Telefon, URL, fiyat ve kod LTR kalır. İstenirse metinleri ajan çevirir. |
| `figma_audit_design_system` | Detached komponent, token'a eşit hardcoded renk, palet dışı renk, grid dışı boşluk ve WCAG AA kontrastı kontrol eder. Güvenli düzeltmeleri otomatik bağlayabilir. |
| `figma_generate_dev_handoff` | Token tablosu, responsive notlar ve SwiftUI / Compose / React-Tailwind / RN kod iskeletini içeren bir `[HANDOFF]` section'ı oluşturur. |
| `figma_preview` | Frame'in görüntüsünü ajana gösterir; ajan kendi sonucunu görsel olarak kontrol edebilir. |
| `figma_undo` | Son işlemde (veya tüm oturumda) oluşturulanları siler. Yerinde yapılan değişiklikler için Cmd/Ctrl+Z hatırlatır. |

## Token verimliliği

- **Az ve birleşik tool:** Varsayılan sette 10 tool var (`FIGMA_STUDIO_TOOLSET=full` ile 14). cursor-talk-to-figma 40 tool tanımlıyor ve tanımları her turda ≈6.470 token tutuyor; bizde ≈2.240.
- **Tek çağrıda tüm iş:** Node ağacı modelin bağlamına girmez; hesaplamayı sunucu yapar. 4 platformluk bir dönüşüm (170 kanvas değişikliği) ≈410 token'lık bir yanıt döndürür.
- **Sade metin yanıtlar:** Varsayılan `detail: "concise"`, gerektiğinde `"detailed"`. Tekrarlayan uyarılar tek satırda gruplanır.
- **Seçim varsayılanı:** `nodeId` verilmezse seçili katman kullanılır, ayrı bir "seçimi getir" çağrısı gerekmez.

## Hazır iş akışları (slash komutları)

Claude Code'da `/figma-studio:adapt_screen`, `localize_rtl`, `audit_and_fix`, `dev_handoff` ve `ship_all_platforms` komutları hazır gelir. Her biri adımları, kuralları ve rapor formatını içeren profesyonel bir runbook'tur.

Gerçek Figma'da test için: [QA kontrol listesi](QA.md) (yaklaşık 20 dakika).

Ayrıntılar için: [README (EN)](../README.md) · [PRD v1.1](PRD.md) · [Mimari](ARCHITECTURE.md)
