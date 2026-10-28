# figma-agent-studio (Türkçe)

**MCP ajanlarıyla (Claude Code, Cursor ve diğerleri) Figma kanvasını yöneten, yerelde çalışan açık kaynak bir DesignOps motoru.**

Masaüstü ekranını seçip ajana söylediğinizde, platform kurallarına uygun **iOS**, **Android (Material 3)**, **Smart TV (10-foot UI)** ve **Tablet** versiyonlarını üretir. Ekranları **RTL'e (Arapça/İbranice)** aynalar, **Design System'e göre denetler** ve kanvasa **geliştirici handoff'u** yazar. Bunları yaparken sizin komponentlerinizi ve token'larınızı kullanır. Bir komponent eksikse kafasına göre kutu çizmez; fuşya bir bayrak açar ve size sorar.

> **Durum: 0.1 (alfa).** Motorlar, köprü, MCP sunucusu ve plugin'in plan uygulayıcısı 160 otomatik testle doğrulandı (Figma Plugin API'sinin katı bir sahte sürümü dahil). Plugin henüz gerçek Figma masaüstü uygulamasında geniş kapsamlı test edilmedi; farklı davranan bir şey görürseniz lütfen issue açın.

## Kurulum (yaklaşık 60 saniye)

1. **MCP sunucusunu ekleyin.**
   - Claude Code: `claude mcp add figma-studio -- npx -y @figma-studio/mcp-server`
   - Cursor: `~/.cursor/mcp.json` → `{"mcpServers":{"figma-studio":{"command":"npx","args":["-y","@figma-studio/mcp-server"]}}}`
2. **Plugin'i yükleyin.** Figma masaüstü uygulamasında *Plugins → Development → Import plugin from manifest…* ile `packages/figma-plugin/manifest.json` dosyasını seçin. Öncesinde `pnpm install && pnpm build` çalıştırın.
3. **Eşleştirin.** Plugin `K7QM-2XPA` gibi bir kod gösterir. Ajana şunu yazın: *"K7QM-2XPA koduyla Figma'ya bağlan, seçili ekranı iOS, Android ve TV için uyarla."*

## Modüller

| Araç | Ne yapar |
|---|---|
| `figma_transpose_surface` | Auto-Layout'u yeniden akıtır. Grid'leri mobilde tek kolona, tablette iki kolona, TV'de D-pad karuseline çevirir. Safe area ekler (Dynamic Island 59pt, Home Indicator 34pt, M3 barları, TV için 80px overscan). Navigasyonu DS komponentleriyle değiştirir. |
| `figma_resolve_missing_component` | Eksik komponent protokolü: **A** token'lardan Master Component üret, **B** en yakın varyantı uyarla, **C** wireframe bırak. |
| `figma_mirror_rtl` | Satırları ters çevirir ve hizalamayı çevirir, padding'leri takas eder, yönlü ikonları flip eder. Telefon, URL, fiyat ve kod LTR kalır. İstenirse metinleri ajan çevirir. |
| `figma_audit_design_system` | Detached komponent, token'a eşit hardcoded renk, palet dışı renk, grid dışı boşluk ve WCAG AA kontrastı kontrol eder. Güvenli düzeltmeleri otomatik bağlayabilir. |
| `figma_generate_dev_handoff` | Token tablosu, responsive notlar ve SwiftUI / Compose / React-Tailwind / RN kod iskeletini içeren bir `[HANDOFF]` section'ı oluşturur. |

Ayrıntılar için: [README (EN)](../README.md) · [PRD v1.1](PRD.md) · [Mimari](ARCHITECTURE.md)
