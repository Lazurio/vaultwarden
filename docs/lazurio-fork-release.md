# Lazurio Vaultwarden: vydávání

Runbook pro vlastníka vydávání Lazurio Vaultwardenu (Steward, dnes Pablo,
`agentrozjedemeai`). Vydání připravíš a spustíš sám; Organization Admin (Matěj,
`immakermatty`) ho jen schválí v GitHub environmentu `release`.

## Co je tenhle fork a proč

`Lazurio/vaultwarden` je veřejný fork
[`dani-garcia/vaultwarden`](https://github.com/dani-garcia/vaultwarden) pod
licencí AGPL-3.0. Staví se z něj Vaultwarden síťových trezorů Lazuria:
Vaultwarden na Conglomerate Hostu každé sítě, ve kterém má každý Environment
svůj prostor pro hesla a passkeys a lidé svůj trezor.

Rozhodnutí DEV-6631 z 2026-10-11 (systémový návrh trezoru Environmentu):

- Lidé vstupují do síťového trezoru jen přes svůj Lazurio účet (SSO). Účet
  e-mailem nikdo nezakládá a nikdo se jím nepřihlašuje.
- Environmenty mají technické účty `vaultwarden@<adresa Environmentu>` s heslem
  a osobním API klíčem; heslo a klíče existují jen v Environmentu. CLI `bw`
  potřebuje heslo jednou, aby si vyzvedlo API klíč, a rozšíření Bitwarden v
  prohlížeči Environmentu se přihlašuje jen heslem.

Upstream to neumí: `SSO_ONLY=true` zavře přihlášení heslem všem účtům, i
technickým. Overlay proto přidává výjimku pro technické účty (viz
[Overlay](#overlay)). Navrhujeme ji upstreamu; fork ji drží, dokud upstream
nevydá ekvivalent. Vzhled a branding zůstávají upstream; vizuální branding
Lazuria přijde později jako samostatný overlay commit.

## Kanál vydání

GitHub Releases tohoto repozitáře a image v GitHub Container Registry
`ghcr.io/lazurio/vaultwarden:X.Y.Z-lazurio.N`. Každé vydání obsahuje:

| Část                         | K čemu                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| image                        | `linux/amd64` z upstream `docker/Dockerfile.debian` (DB `sqlite,mysql,postgresql`), se SBOM a provenance BuildKitu a s podepsanou attestací původu |
| `release-evidence.json`      | zdrojový commit a tag, upstream tag a jeho commit, digest image, odkaz na attestaci a běh workflow                                                 |
| release notes                | overlay commity, digest, attestace                                                                                                                |
| zdrojové archivy GitHubu     | přesný zdroj tagu (viz [Zdrojový kód](#zdrojový-kód-agpl-30))                                                                                     |

Machines image pinují **digestem**, nikdy jen tagem: `vaultwarden_image` ve
`workloads/conglomerate-host/ansible/versions.yml` je
`ghcr.io/lazurio/vaultwarden:X.Y.Z-lazurio.N@sha256:…`, hodnota
`artifact.reference` z `release-evidence.json`. Tag je jen čitelný alias.

Vydává se jen `linux/amd64`: Conglomerate Hosty jsou x86_64 (Machines to
vynucují v `workloads/conglomerate-host/ansible/playbooks/apply.yml`). Lab na
Macu si postaví nativní arm64 image lokálně (viz
[Testování](#testování-před-vydáním)). arm64 vydání přidej, až ho bude
potřebovat skutečný host.

Publikace nikoho nepřepne. Síť přejde na novou verzi až PR v Machines se
zvýšeným pinem a jeho apply (viz [Pin v Machines](#pin-v-machines)).

### Verze

- Verze je `X.Y.Z-lazurio.N`, tag `vX.Y.Z-lazurio.N`. `X.Y.Z` je upstream
  stable tag, na kterém `main` stojí (upstream tagy jsou bez `v`, například
  `1.37.4`).
- `N` začíná na 1 a roste s každým vydáním nad stejnou bází; nová upstream báze
  začíná znovu od `.1`. `X.Y.Z-lazurio.0` nikdy nevychází, používá ji jen CI.
- Workflow odmítne verzi, která není vyšší než všechna publikovaná vydání, a
  nikdy nepřepíše existující vydání, tag ani image.
- Binárka hlásí přesnou verzi: `/vaultwarden --version`, `GET /api/version` a
  diagnostika v `/admin`.
- Preview kanál nemáme. Canary je pin nového digestu nejdřív na Conglomerate
  Hostu HumanAndMachine.

## Overlay

`main` je přesný upstream stable tag a nad ním jen tyto commity:

| Commit                                    | Proč ho Lazurio potřebuje                                                                                                                                                                                                                              | Retain / drop                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sso: technical accounts beside SSO_ONLY` | Výjimka technických účtů z `SSO_ONLY` (`SSO_ONLY_EXEMPT_EMAILS`, `SSO_ONLY_API_KEY`), viz níže. Mění `src/config.rs`, `src/api/identity.rs`, `src/api/core/accounts.rs`, `src/api/core/organizations.rs`, `src/api/core/emergency_access.rs`, `src/api/core/public.rs`, `src/auth.rs`, `src/mail.rs` a dokumentaci v `.env.template`; databázi nemění. | **Retain**, dokud upstream nevydá ekvivalent. Navrženo upstreamu (odkaz na PR doplň sem, až vznikne). **Drop** při první přestavbě na upstream vydání, které ekvivalent obsahuje; Machines ve stejném rolloutu přejdou na upstream jména voleb. |
| `release: Lazurio distribution`           | Tento runbook a workflow `lazurio-fork-ci.yml` a `lazurio-release.yml`.                                                                                                                                                                               | **Retain**.                                                                                                                                                                                                                                                    |

Vizuální branding Lazuria přijde jako samostatný overlay commit s vlastním
řádkem v této tabulce a v allowlistu CI.

### Co výjimka dělá a co ne

- `SSO_ONLY_EXEMPT_EMAILS` je regex, který musí odpovídat **celé** e-mailové
  adrese (malými písmeny; ukotvení `^…$` doplní server sám). Lazurio používá
  adresy Environmentů:
  `^vaultwarden@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.lazurio\.io$`.
  Neplatný regex server odmítne při startu (exit 12) i při uložení v `/admin`.
- S `SSO_ONLY=true`:
  - přihlášení heslem (`grant_type=password`) a jeho obnovení přes refresh
    token zůstanou jen adresám z výjimky;
  - e-mailová registrace se odmítne každé jiné adrese, i když pro ni existuje
    pozvánka. Proto nikdo nezaregistruje účet pozvaného člověka dřív, než se
    ten poprvé přihlásí přes SSO;
  - pozvánkový e-mail na adresu z výjimky nevede do SSO (týká se jen sítí se
    SMTP).
- Vždy, i bez `SSO_ONLY`:
  - SSO odmítne každé přihlášení, jehož e-mail od poskytovatele identity
    odpovídá výjimce, ještě než hledá účet. Proto SSO technický účet nikdy
    nezaloží ani nespáruje;
  - žádný účet si nezmění e-mail na adresu z výjimky. Server výjimku ověří
    při žádosti o změnu i při jejím dokončení, protože se výjimka mezitím
    může změnit;
  - účet s adresou z výjimky nezaloží pozvánka organizace, pozvánka do
    nouzového přístupu ani import Directory Connectoru (organizační API
    klíč). Zakládá ho jen admin pozvánkou v `/admin`.
- `SSO_ONLY_API_KEY=true` (opt-in): s `SSO_ONLY` odmítne i osobní API klíč
  (`bw login --apikey`) každého účtu mimo výjimku, takže klíč vyrobený v SSO
  relaci SSO neobejde. Organizační API klíče se nemění.
- Co nedělá: nezakládá účty (technický účet se dál registruje na pozvánku sítě
  přes `/admin/invite`) a nemění `/admin`. Webový trezor dál ukazuje lidem jen
  přihlášení přes SSO. Výjimka nemění 2FA, Auth ani nastavení organizací.

Nenastavené volby zachovají upstream chování, s jedinou výjimkou: s
`SSO_ONLY=true` už nejde e-mailová registrace. Upstream ji pouštěl, ačkoli se
takový účet heslem stejně nepřihlásil.

### Allowlist

CI odmítne změnu jakéhokoli souboru mimo `allowed_changes` v
`lazurio-fork-ci.yml`. Každý řádek je vědomé rozhodnutí. Nový overlay commit
přidá své soubory ve stejném PR se zdůvodněním a s řádkem v tabulce výše. Při
každé přestavbě allowlist znovu projdi a odeber, co už overlay nemění.

### Upstream workflow ve forku

Overlay žádný upstream workflow nemění. Ve forku jsou na tom takto:

| Workflow                                                                     | Ve forku                                                                                                                                                                                                       | Co s ním                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `release.yml`                                                                | Job `docker-build` má `if: github.repository == 'dani-garcia/vaultwarden'` a `merge-manifests` na něm závisí, takže se oba přeskočí. Spouští se na push do `main` a na upstream tagy `X.Y.Z`, ne na naše `vX.Y.Z-lazurio.N`. | Beze změny. Jmenuje také environment `release`, ale přeskočený job do něj nikdy nevstoupí. |
| `trivy.yml`                                                                  | Hlídaný stejným `github.repository == 'dani-garcia/vaultwarden'`; GitHub ho ve forku navíc drží vypnutý (`disabled_fork`).                                                                                       | Beze změny.                                                                                 |
| `releasecache-cleanup.yml`                                                   | Bez guardu, ale GitHub ho ve forku drží vypnutý (`disabled_fork`, plánovaný workflow). Mazal by jen balíček `vaultwarden-buildcache`, který Lazurio nemá.                                                       | Nezapínej ho.                                                                               |
| `build.yml`, `check-templates.yml`, `hadolint.yml`, `typos.yml`, `zizmor.yml` | Běží na GitHub runnerech bez secrets.                                                                                                                                                                          | Beze změny; jsou to užitečné další kontroly (zizmor kontroluje i naše workflow).            |

Když přestavba přinese nový upstream workflow, který potřebuje secrets,
pushuje image nebo by reagoval na naše tagy, vypni ho v nastavení Actions
(`gh workflow disable <id> --repo Lazurio/vaultwarden`) a přidej sem řádek.
Upstream soubory kvůli tomu neměň.

## Kdy vydávat

- **Nové upstream stable vydání**, hlavně bezpečnostní (samotná 1.37.4 opravila
  sedm zranitelností): přestav overlay na nový tag (viz
  [Přestavba](#přestavba-na-nový-upstream-tag)) a vydej `X.Y.Z-lazurio.1`.
- **Oprava nebo změna overlaye** na stejné bázi: po merge do `main` vydej další
  `-lazurio.N`.
- Vydává se jen z `main`. PR do `main` se mergují jen rebase, bez merge
  commitu; CI i release odmítnou merge commit nad upstream tagem.

## Testování před vydáním

1. **CI.** `Lazurio Fork CI` musí být zelené na PR i na `main`. Běží v něm:
   - `Overlay on the upstream tag`: zdroj stojí na přesném upstream tagu
     (`UPSTREAM_TAG`, `UPSTREAM_SHA`), nemá merge commity a mění jen soubory z
     allowlistu;
   - `Format, lint and test`: `cargo fmt`, `cargo clippy` a `cargo test` s
     featurami release image (`sqlite,mysql,postgresql`); varování jsou chyby;
   - `Release image and overlay smoke test`: image postavený stejně jako při
     vydání, pod verzí `X.Y.Z-lazurio.0`, a smoke test bez IdP. Ověří verzi a
     odmítnutí neplatného regexu při startu. S `SSO_ONLY` ověří, že technický
     účet se zaregistruje, přihlásí heslem, obnoví relaci a přihlásí API
     klíčem, ale nezmění e-mail na adresu z výjimky, a že člověk se e-mailem
     nezaregistruje ani nepřihlásí heslem. Dále ověří, že import Directory
     Connectoru nezaloží účet s adresou z výjimky a že čekající změnu e-mailu
     nejde dokončit, když admin mezitím přidá novou adresu do výjimky.
2. **Lab se SSO** při změně overlaye a při každé nové upstream bázi. Smoke test
   nemá IdP, takže SSO stranu ověř v labu: image postavený lokálně (na Macu
   stačí nativní arm64:
   `docker build -f docker/Dockerfile.debian --build-arg DB=sqlite --build-arg VW_VERSION=X.Y.Z-lazurio.0 -t lazurio-vaultwarden:lab .`),
   Dex jako zástupce Lazurio Auth a připnuté `bw`, vždy s vlastním
   `BITWARDENCLI_APPDATA_DIR`. Ověř aspoň, že:
   - SSO odmítne přihlášení, které tvrdí adresu technického účtu;
   - osobní API klíč člověka se s `SSO_ONLY_API_KEY` nepřihlásí;
   - technický účet se přes `bw` přihlásí heslem i API klíčem;
   - člověk s SSO relací si nezmění e-mail na adresu z výjimky. Nedokončí ani
     změnu zahájenou dřív, než restart s novou konfigurací adresu do výjimky
     přidal;
   - Environment založí organizaci a pozve a potvrdí člověka přihlášeného přes
     SSO;
   - člověk, který organizaci vlastní, nezaloží importem Directory Connectoru
     účet s adresou z výjimky.

   Výsledek uveď v PR. Lab D z DEV-6631 ověřuje právě tohle (21 kontrol).

## Spuštění vydání

Vydání spustí push tagu. Tag dávej jen na commit z `main`, na kterém je zelené
`Lazurio Fork CI`, typicky na jeho špičku:

```bash
VERSION=1.37.4-lazurio.1
SOURCE_SHA="$(git ls-remote https://github.com/Lazurio/vaultwarden.git refs/heads/main | cut -f1)"
gh run list --repo Lazurio/vaultwarden --workflow lazurio-fork-ci.yml --commit "$SOURCE_SHA" \
  --json conclusion,event,url --jq '.[] | select(.conclusion == "success")'
git fetch origin main
git tag -a "v$VERSION" -m "Lazurio Vaultwarden $VERSION" "$SOURCE_SHA"
git push origin "refs/tags/v$VERSION"
gh run list --repo Lazurio/vaultwarden --workflow lazurio-release.yml --limit 1
```

Workflow `Lazurio Vaultwarden Release`:

1. **Verify tag, source and CI** ověří:
   - tvar tagu `vX.Y.Z-lazurio.N` s `N ≥ 1`;
   - že tag ukazuje na commit na `main`;
   - že commit stojí na přesném upstream tagu `X.Y.Z` (ověřeno proti
     `dani-garcia/vaultwarden`) bez merge commitů;
   - že `lazurio-fork-ci.yml` v tom commitu deklaruje stejný upstream tag a
     commit;
   - úspěšný běh `Lazurio Fork CI` na přesně tomto commitu;
   - že vydání tagu ještě neexistuje a verze je vyšší než všechna publikovaná.

   Když CI ještě nedoběhlo, job selže; po zeleném CI ho spusť znovu (Re-run
   failed jobs). Tag nemaž ani nepřesouvej.
2. **Publish image and release** čeká na schválení v environmentu `release`
   (viz [Schválení](#schválení)). Po schválení:
   - před jakýmkoli zápisem ověří, že environment je nastavený podle runbooku
     (proměnná `LAZURIO_VAULTWARDEN_RELEASE_CONTROL`) a že tag pořád ukazuje na
     ověřený commit;
   - odmítne existující tag image;
   - postaví bez cache z upstream `docker/Dockerfile.debian` image `linux/amd64`
     s `VW_VERSION=X.Y.Z-lazurio.N` a OCI labely (zdroj, revize, licence) a
     pushne ho se SBOM a provenance BuildKitu;
   - stáhne image podle digestu a ověří verzi a přítomnost overlaye (neplatný
     `SSO_ONLY_EXEMPT_EMAILS` zastaví start);
   - podepíše attestaci původu (`actions/attest-build-provenance`) a uloží ji k
     image;
   - publikuje GitHub Release jako `latest` s release notes a
     `release-evidence.json`.

Když publish selže až po pushi image, zůstane tag image bez vydání. Tu verzi už
nepoužívej a vydej další `N`.

## Schválení

Až je `Verify tag, source and CI` zelené, požádej Matěje o schválení a pošli mu
odkaz na běh. Matěj ho schválí v GitHubu (běh → Review deployments → `release`
→ Approve). Jediný povinný schvalovatel je Matěj a environment zakazuje schválit
vlastní běh, takže tag pushuješ ty, ne Matěj. Když si vydání rozmyslíš, Matěj
běh odmítne (Reject) a nic se nepublikuje.

## Ověření publikovaného vydání

```bash
VERSION=1.37.4-lazurio.1
mkdir -p "/tmp/vaultwarden-$VERSION" && cd "/tmp/vaultwarden-$VERSION"
gh release download "v$VERSION" --repo Lazurio/vaultwarden --pattern release-evidence.json
REFERENCE="$(jq -r .artifact.reference release-evidence.json)"   # ghcr.io/lazurio/vaultwarden:X.Y.Z-lazurio.N@sha256:…
DIGEST="$(jq -r .artifact.digest release-evidence.json)"
gh attestation verify "oci://ghcr.io/lazurio/vaultwarden@$DIGEST" --repo Lazurio/vaultwarden
docker buildx imagetools inspect "ghcr.io/lazurio/vaultwarden:$VERSION" | grep -m1 '^Digest:'   # = $DIGEST
docker run --rm --platform linux/amd64 --entrypoint /vaultwarden "$REFERENCE" --version         # Vaultwarden X.Y.Z-lazurio.N
```

## Pin v Machines

Na vydání síť přejde PR v Machines:

- `vaultwarden_image: "ghcr.io/lazurio/vaultwarden:X.Y.Z-lazurio.N@sha256:…"`,
  hodnota `artifact.reference` z `release-evidence.json`;
- konfigurace jako kód: `SSO_ONLY=true`, `SSO_ONLY_EXEMPT_EMAILS` (regex výše),
  `SSO_ONLY_API_KEY=true` a ostatní SSO volby podle návrhu DEV-6631;
- před změnou verze šifrovaná záloha trezoru (backup gate);
- Pablo review, Permit, apply po sítích jako běžné lanes, readback (digest
  běžícího kontejneru, `GET /api/version`, konfigurace) a kontrola v prohlížeči;
- canary je Conglomerate Host HumanAndMachine, ostatní sítě až po něm.

Overlay nepřidává žádnou migraci databáze. Image `X.Y.Z-lazurio.N` a upstream
`vaultwarden/server:X.Y.Z` proto běží nad stejnou databází a mezi vydáními
téže upstream báze se dá přepnout bez obnovy dat.

## Rollback

- Chybné vydání nahradí vyšší verze. Vydání, tagy ani image nemaž.
- Na síti se vrátíš pinem v Machines na předchozí digest. Na stejné upstream
  bázi to obnovu dat nepotřebuje. Napříč upstream verzemi jsou migrace jen
  dopředné, takže pin starší báze vyžaduje obnovu zálohy pořízené před změnou.
- Upstream `vaultwarden/server` volby `SSO_ONLY_EXEMPT_EMAILS` a
  `SSO_ONLY_API_KEY` nezná a ignoruje je. Návrat na upstream image s
  `SSO_ONLY=true` proto zavře heslo i Environmentům: nové Environmenty se
  nezaregistrují a rozšíření v prohlížeči se nepřihlásí. Pro takový návrat
  přepni síť na `SSO_ONLY=false`, tedy na dočasný stav s pojmenovaným reziduem
  z návrhu DEV-6631.

## Přestavba na nový upstream tag

`main` je rolling patch-stack. Starý `main` se neslučuje ani nepřehrává
hromadně. Přestavbu připravuješ ty (Steward): candidate branch, checky a přesná
SHA. Samotnou výměnu `main` provádí Organization Admin, tedy Matěj, nebo jeho
Task Agent na jeho výslovný pokyn vázaný na obě SHA.

1. Založ zrcadlo upstream tagu jako bázi pro review:

   ```bash
   git fetch https://github.com/dani-garcia/vaultwarden.git "refs/tags/X.Y.Z:refs/tags/X.Y.Z"
   git push origin "$(git rev-parse 'X.Y.Z^{commit}'):refs/heads/upstream/X.Y.Z"
   ```

2. Z přesného upstream tagu založ candidate branch
   (`git switch -c lazurio/X.Y.Z 'X.Y.Z^{commit}'`). Každý commit overlaye
   přenes podle záměru (`git cherry-pick`, případně ručně) a overlay zmenši o
   všechno, co už upstream umí.
3. V `lazurio-fork-ci.yml` aktualizuj `UPSTREAM_TAG` a `UPSTREAM_SHA` a projdi
   allowlist.
4. Otevři PR `lazurio/X.Y.Z` → `upstream/X.Y.Z`; jeho diff je přesně overlay.
   Počkej na zelené `Lazurio Fork CI`, udělej lab podle
   [Testování](#testování-před-vydáním) a nech PR zreviewovat. Pak předej
   Adminovi přesný starý `main` (`expected_old_main`) a přesný nový head
   (`candidate_head`) s odkazem na zelený běh.
5. Než se `main` přepne, musí být současný `main` zachycený publikovaným
   **immutable** vydáním `v…-lazurio.N`. Tag vydání míří buď přesně na starý
   `main`, nebo na jeho předka, od kterého se starý `main` liší jen v `docs/`.
   Ověř to:

   ```bash
   expected_old_main="$(git ls-remote https://github.com/Lazurio/vaultwarden.git refs/heads/main | cut -f1)"
   capture=v1.37.4-lazurio.1   # poslední vydání
   git fetch origin main "refs/tags/$capture:refs/tags/$capture"
   capture_sha="$(git rev-parse "$capture^{commit}")"
   git merge-base --is-ancestor "$capture_sha" "$expected_old_main"
   git diff --quiet "$capture_sha" "$expected_old_main" -- . ':(exclude)docs/'
   test "$(gh api "repos/Lazurio/vaultwarden/releases/tags/$capture" --jq .immutable)" = true
   ```

   Pokud starý `main` mění proti poslednímu vydání cokoli mimo `docs/`, vydej ho
   nejdřív. Docs commity starého `main` přenes do candidate.
6. Admin vymění `main`:

   ```bash
   git push --force-with-lease="refs/heads/main:$expected_old_main" \
     origin "$candidate_head:refs/heads/main"
   ```

   Neúspěšný lease znamená souběžnou změnu. Nikdy ho automaticky neopakuj. PR
   do `upstream/X.Y.Z` se nemerguje; zavři ho s odkazem na nový `main`.
7. Z nového `main` vydej `X.Y.Z-lazurio.1` a pinni ho v Machines.

### První zavedení `main`

Dnes je `main` forku upstream `main` (`64895524`), žádné vydání, takže není co
zachytit.

1. PR `lazurio/1.37.4` → `upstream/1.37.4` (`upstream/1.37.4` je upstream tag
   `1.37.4`, commit `7c188967`) projde zeleným CI a review. Kandidát obsahuje
   tento runbook.
2. Admin vymění `main` na hlavu PR (`candidate_head`) a PR zavře s odkazem:

   ```bash
   git push --force-with-lease="refs/heads/main:64895524e481492130061b95aa4433118f6b1c59" \
     origin "$candidate_head:refs/heads/main"
   ```

3. [Jednorázové nastavení](#jednorázové-nastavení-admin), pak první vydání
   `v1.37.4-lazurio.1` a pin v Machines.

## Jednorázové nastavení (Admin)

- Environment `release`:
  - povinný schvalovatel Matěj (`immakermatty`), zakázané schválení vlastního
    běhu;
  - deployment refs jen tagy `v*-lazurio.*`;
  - proměnná `LAZURIO_VAULTWARDEN_RELEASE_CONTROL=reviewed-v1`. Publish bez ní
    skončí dřív, než cokoli zapíše. To chrání před environmentem, který by
    GitHub při prvním běhu vytvořil sám, bez schvalovatele.
- Ruleset pro `main`: jen rebase merge, lineární historie, povinné checky
  `Overlay on the upstream tag`, `Format, lint and test` a
  `Release image and overlay smoke test`; force push jen bypassem Organization
  Admina (přestavba a první zavedení).
- Ruleset pro tagy `v*-lazurio.*`: zákaz update a smazání; vytvořit je smí jen
  Steward a Admin.
- Release immutability v nastavení repozitáře (Settings → General → Releases),
  aby šel starý `main` zachytit neměnným vydáním.
- Po prvním vydání balíček `ghcr.io/lazurio/vaultwarden`: propojený s tímto
  repozitářem (label `org.opencontainers.image.source`), viditelnost **Public**
  (Machines ho stahují bez přihlášení) a tento repozitář v Manage Actions access
  s rolí Write.

## Zdrojový kód (AGPL-3.0)

Vaultwarden je pod AGPL-3.0-only. Upravená verze, se kterou uživatelé sítě
pracují přes síť, jim musí nabídnout odpovídající zdrojový kód. Zdrojem
každého image je tento veřejný repozitář na tagu `vX.Y.Z-lazurio.N`:

- image nese labely `org.opencontainers.image.source` a
  `org.opencontainers.image.revision` a binárka hlásí `X.Y.Z-lazurio.N`
  (`GET /api/version`);
- vydání obsahuje zdrojové archivy tagu a `release-evidence.json` váže digest
  image na commit; attestace to podepisuje;
- repozitář zůstává veřejný a image nikdy nevzniká z commitu, který tu není pod
  tagem vydání;
- vydání, tagy ani image se nemažou, aby zdroj každého nasazeného image zůstal
  dostupný.

## Co nedělat

- Nemaž ani nepřepisuj vydání, tagy ani image. Chybné vydání nahradí vyšší
  verze.
- Nepublikuj ručně (`gh release create`, `docker push`); kanál plní jen
  workflow.
- Nepushuj na `main` s force mimo
  [přestavbu](#přestavba-na-nový-upstream-tag) a
  [první zavedení](#první-zavedení-main).
- Nezapínej `releasecache-cleanup.yml` a nespouštěj upstream `release.yml`.
- Nespouštěj `bw` bez vlastního `BITWARDENCLI_APPDATA_DIR`; jinak přepíše
  profil toho, kdo na stroji pracuje.
- Nepiš do repozitáře nic, co patří konkrétní Organizaci: repozitář je veřejný.
