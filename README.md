# HG-SWD FW Hub

**made by Higenis**

[HG-SWD-PROG](https://github.com/dong-higenis/HG-SWD-PROG) 오프라인 프로그래머에 넣을 펌웨어를 칩별로 등록하고 배포하는 저장소입니다. STM32H723(SWD)과 ESP32 / ESP32-S3 / ESP32-C3(UART)를 지원합니다. `main`에 올리면 GitHub Actions가 검사한 뒤 GitHub Pages로 게시합니다.

- 사이트: <https://can-dubu.github.io/hg-swd-fw-hub/>
- 사람은 사이트에서 칩·프로젝트·버전을 찾아 **SD 패키지(zip)** 를 받습니다.
- 펌웨어는 사이트의 **등록** 페이지에서 올립니다. PR이 만들어지고, CI 통과 후 머지하면 게시됩니다.
- 프로그래머(추후 LTE)는 `fw/<id>/latest.txt`를 읽어 새 버전을 받습니다.

## 구조

```text
registry/
├── chips/<chip>.toml          칩. kind = "stm32"(device, 로더, Flash 범위, SP RAM 범위)
│                              또는 "esp"(device, 이미지 칩 ID, 부트로더 주소)
│                              device가 같은 칩끼리는 shared_device 규칙 (아래 검사 항목)
├── loaders/<loader>.toml      STM32 Flash 로더 지문(크기, CRC32, SHA-256). 파일은 배포하지 않음
├── licenses/<name>.txt        NOTICE.txt가 licenses/<name>.txt로 가리키는 라이선스 전문
└── firmware/<id>/             프로젝트 = SD의 /prog/fw/<id>/
    ├── project.toml
    ├── NOTICE.txt             펌웨어에 들어간 오픈소스의 저작권·라이선스 고지 (필수)
    └── <version>/
        ├── release.toml
        ├── app.bin                                      STM32
        └── bootloader.bin, partitions.bin, firmware.bin ESP (또는 merged.bin 하나)
tools/build_registry.py        검사 + 사이트 생성 (Python 3.11+ 표준 라이브러리만 사용)
tests/                         빌더 테스트
web/                           정적 UI (manifest.json 렌더링, upload.js = 등록 페이지)
```

## 펌웨어 등록

사이트의 **등록**(`#/upload`) 페이지에서 칩과 프로젝트를 고르고 BIN을 올립니다. device, 로더, 기록 주소는 칩이 정하므로 입력하지 않습니다. STM32는 `app.bin` 하나, ESP는 고정 슬롯 3개(`bootloader.bin`, `partitions.bin`, `firmware.bin`)에 올리거나, 통파일(merged.bin) 하나를 올리고 UART 속도 상한을 고릅니다. 두 방식의 장단점은 파일 창에 나옵니다. 브라우저가 이미지를 검사하고 `fw.txt`를 미리 보여 준 뒤, GitHub API로 `fw/<id>-<ver>` 브랜치와 커밋 하나, PR을 만듭니다.

1. PR에서 CI(`Build and deploy`)가 통과했는지 확인합니다. 브라우저 검사는 편의용이고, 최종 판단은 CI의 `build_registry.py`가 합니다.
2. Merge 하면 main 빌드가 사이트를 다시 배포합니다.

토큰은 fine-grained PAT 하나면 됩니다. 이 저장소만 선택하고 **Contents**와 **Pull requests**를 Read and write로 줍니다. 토큰은 브라우저 저장소에만 두고 `api.github.com` 외에는 보내지 않습니다. 기본은 탭을 닫으면 지워지는 sessionStorage입니다.

직접 폴더를 만들어 커밋해도 됩니다. 방법은 [registry/firmware/README.md](registry/firmware/README.md)에 있습니다.

## 생성물

| 경로 | 용도 |
| --- | --- |
| `manifest.json` | 칩·로더·프로젝트·전체 버전. 사이트와 기기가 같이 읽는 기준 데이터 |
| `fw/<id>/latest.txt` | 최신 정식 버전 요약. `fw.txt`처럼 `key=value` 형식 |
| `fw/<id>/<ver>/<image>` | 이미지. STM32는 `app.bin`, ESP는 `bootloader.bin`, `partitions.bin`, `firmware.bin`과 생성된 `ota-reset.bin` |
| `fw/<id>/<ver>/fw.txt` | 프로그래머가 읽는 매니페스트. HG-SWD-PROG의 `prepare_h723_sd.py` / `prepare_esp_sd.py` 출력과 바이트 단위로 같음 |
| `fw/<id>/<ver>/release.txt` | 칩·버전 정보. 기기가 `fw.txt`만으로는 알 수 없는 값 |
| `fw/<id>/<ver>/NOTICE.txt` | 펌웨어에 들어간 오픈소스 고지. SD 패키지에는 `prog/fw/<id>/NOTICE.txt`로 들어감 |
| `licenses/<name>.txt` | 라이선스 전문. SD 패키지에는 그 프로젝트의 NOTICE.txt가 가리키는 것만 `prog/licenses/`로 들어감 |
| `fw/<id>/<ver>/<id>-<ver>-sd.zip` | `prog/` 폴더째 SD 루트에 푸는 패키지 |

`latest.txt` 예(ESP):

```ini
schema=1
id=hg-esp32-s3-rly4pro
chip=esp32s3
version=1.0.0
date=2026-10-13
base=fw/hg-esp32-s3-rly4pro/1.0.0/
file=bootloader.bin,19984,0x6AA603B4,b41be55a…
file=partitions.bin,3072,0xF03E088A,ace02503…
file=ota-reset.bin,8192,0xB4293435,7d2c7ac4…
file=firmware.bin,367024,0x86B519A4,e271109b…
file=release.txt,75,0xE67D227D,66937476…
file=fw.txt,287,0x77430E3E,7e78d13c…
```

`file=이름,크기,CRC32,SHA-256` 줄마다 `base` + 이름으로 받아 **적힌 순서대로** SD에 씁니다. 줄 수는 칩과 버전마다 다르므로 세지 말고 끝까지 읽습니다. **`release.txt`와 `fw.txt`가 항상 마지막 두 줄이고, `fw.txt`는 SD에도 마지막에 씁니다.** 그래야 중간에 끊긴 복사본이 선택 가능한 프로젝트로 보이지 않습니다. 경로는 사이트 루트 기준입니다. `schema` 값이 바뀌면 호환되지 않는 변경이고, 키나 `file=` 줄이 늘어나는 것은 호환되는 변경입니다. 모르는 키는 무시합니다.

### release.txt

SD 패키지의 `prog/fw/<id>/release.txt`와 사이트의 같은 파일은 내용이 같습니다. 형식은 `latest.txt`의 앞부분과 같은 `key=value`이고, CI는 줄 끝을 LF로 씁니다.

```ini
schema=1
id=hg-esp32-s3
chip=esp32s3            # registry/chips/<chip>.toml의 파일 이름
version=1.0.0           # x.y.z 또는 x.y.z-tag
date=2026-10-12
```

기기의 해석 규칙(HG-SWD-PROG는 이대로 구현합니다):

- 모르는 키, `#`으로 시작하는 줄, 빈 줄은 무시합니다. 줄 끝은 CRLF와 LF를 모두 허용하고, 키와 값의 앞뒤 공백은 잘라 냅니다.
- 파일이 1 KiB를 넘거나, `schema`가 `1`이 아니거나, 같은 키가 두 번 나오면 `release.txt`가 없는 것으로 취급합니다.
- `version`은 `x.y.z` 또는 `x.y.z-tag` 형식이고 31자 이하일 때만 표시합니다. `id`는 참고용이며 폴더 이름과 달라도 됩니다.
- `release.txt`는 표시와 칩 구분에만 씁니다. 기록할지와 무엇을 기록할지는 `fw.txt`가 정합니다.
- `chip=`이 가리키는 칩의 device 문자열이 `fw.txt`의 `device=`와 같을 때만 `chip=`을 믿습니다. 다르거나 기기가 모르는 칩이면 Unknown으로 분류되며 기록할 수 없습니다.
- `release.txt`가 없으면 `device=`로 판단하며, 그 device 그룹에서 `shared_device`가 없는 칩으로 분류합니다.

`fw.txt`에 키를 더하지 않고 파일을 따로 두는 이유: 기기의 `fw.txt` 파서(`prog_inspect.c`, `esp_project.c`)가 모르는 키를 거부합니다. 반면 패키지 목록(`prog_catalog.c`)은 `fw.txt`와 거기 적힌 BIN만 읽으므로, 이미 배포된 프로그래머는 `release.txt`를 무시합니다.

### SD카드에 둘 수 있는 개수

SD에는 칩 구분 없이 최대 16개까지 둘 수 있습니다. 넘으면 프로젝트 ID 알파벳순으로 앞의 16개만 표시되고, Installed bin에 16+가 표시됩니다.

### 게시한 버전의 불변 범위

게시한 버전에서 바꾸지 않는 것은 **기기에 기록되는 바이트**, 곧 이미지 파일과 `fw.txt`입니다. 레지스트리의 버전 폴더(`registry/firmware/<id>/<ver>/`)도 고치지 않습니다. 반면 SD zip, zip 안의 `README.txt`, `release.txt`, `latest.txt`는 레지스트리에서 매번 다시 만드는 포장물입니다. 패키지 형식이 바뀌면 이전 버전 것도 다시 만들어지며, 이때 `manifest.json`의 `sd_zip.sha256`도 바뀝니다.

## 검사 항목

규칙은 HG-SWD-PROG의 `prog.c`, `prog_inspect.c`, `esp_project.c`, `prepare_esp_sd.py`와 같습니다. 웹 등록 페이지도 같은 검사를 브라우저에서 먼저 보여 줍니다.

공통

- 프로젝트 ID: `A-Z a-z 0-9 _ -` 1~24자
- 이름: 출력 가능한 ASCII 1~47자. `fw.txt`는 1,024바이트 이하
- 버전 폴더: `x.y.z` 또는 `x.y.z-tag`. 태그가 붙은 버전은 프리릴리스이며 `latest`에서 제외
- 칩 `device`: 기기는 `fw.txt`의 `device=`를 정확히 같은 문자열로 비교해서 칩을 고릅니다(`prog_target.c`). 나중에 추가한 칩이 기존 칩과 device 문자열을 같이 쓰면, 그 칩에만 `shared_device = true`를 넣습니다. 뜻은 "`release.txt`의 `chip=`이 있어야만 이 칩으로 인식된다"입니다.
  - device 문자열이 같은 칩 그룹마다 `shared_device`가 없는 칩이 정확히 1개여야 함. `release.txt`가 없는 패키지는 이 칩으로 분류되기 때문입니다. 공유할 칩이 없는데 `shared_device`를 넣어도 오류
  - `shared_device` 칩의 SD 패키지에는 `release.txt`가 반드시 있어야 함

STM32

- 이미지: 칩 Flash 크기 이하이며 Flash 시작 주소의 벡터 테이블부터 시작해야 함. 초기 SP는 칩 RAM 범위 안에 있고 8바이트 정렬이어야 하며, Reset 벡터는 Thumb이고 이미지 안을 가리켜야 함
- `0x400`의 `VER ` 헤더: 주소가 맞는지 확인하고, 내장 버전을 사이트에 표시. 폴더 버전과 다르면 경고만 함

ESP

- `bootloader.bin`, `firmware.bin`: `0xE9` 헤더, 선택한 칩의 칩 ID, 세그먼트 체크섬, 붙어 있는 SHA-256. 두 파일의 Flash 크기 설정(1~16 MiB)이 같아야 함
- `merged.bin`(통파일): 부트로더 주소, `0x8000`, `0x10000`에서 세 파일을 잘라 위와 같이 검사. 기록하지 않는 영역(OTA data 제외)은 모두 0xFF여야 함
- `bootloader.bin`은 `0x8000` 전에 끝나야 함. `partitions.bin`은 4 KiB 이하이며 MD5가 맞아야 함
- 파티션 표: `0x10000`에 `firmware.bin`이 들어가는 factory/ota_0 앱. OTA data가 있으면 8 KiB여야 하며, 이때 `ota-reset.bin`(0xFF)을 생성해 app0으로 부팅하게 함
- 이미지끼리 4 KiB 삭제 범위가 겹치지 않아야 함. `release.toml`의 `baud`는 `auto`, `921600`, `460800`, `230400`, `115200`
- `firmware.bin`의 앱 정보(버전·이름·IDF)는 참고용으로만 표시. Arduino 빌드는 버전 칸이 라이브러리 커밋이라 비교하지 않음

## 로컬 실행

```powershell
python -m unittest discover -s tests
python tools/build_registry.py --check          # 검사만
python tools/build_registry.py                  # _site/ 생성
python -m http.server -d _site 8000             # http://localhost:8000
```

## 최초 설정

- **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿉니다.
- 권장: **Settings → General → Automatically delete head branches**를 켜서, 머지한 `fw/*` 브랜치가 자동으로 지워지게 합니다.
- 웹 등록은 main 브랜치가 있어야 동작합니다. 첫 커밋을 먼저 푸시하세요.

## 라이선스

이 저장소의 코드는 [MIT License](LICENSE)입니다. `registry/firmware/`의 펌웨어 바이너리는 여기에 포함되지 않고, 각 프로젝트의 `NOTICE.txt`를 따릅니다. 사이트가 쓰는 외부 리소스와 펌웨어별 구성 요소는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 모아 두었습니다.

펌웨어를 공개 배포하므로 프로젝트마다 `NOTICE.txt`가 있어야 합니다. CI가 검사하는 항목은 다음과 같습니다.

- 파일이 있어야 하고 UTF-8이며 비어 있지 않아야 합니다. `<ver>/NOTICE.txt`가 있으면 그 버전에는 그것을 씁니다(라이브러리가 바뀐 버전).
- `TODO`가 남아 있으면 안 됩니다. 등록 페이지가 새 프로젝트에 넣는 초안은 확인할 곳을 `TODO`로 남겨 둡니다.
- `licenses/<name>.txt`로 가리킨 파일은 `registry/licenses/`에 있어야 합니다. SD 패키지에는 가리킨 파일만 들어갑니다.

`NOTICE.txt`에 무엇을 적을지는 빌드한 사람이 확인해야 합니다. 링크된 라이브러리는 빌드의 `.map` 파일에서, Arduino-ESP32 코어 버전은 Boards Manager에서 확인합니다. Arduino-ESP32 코어는 LGPL-2.1이므로, 고지 외에 라이브러리 소스와 다시 링크할 수 있는 자료를 받을 수 있게 하는 의무도 따릅니다.

## 로더 라이선스

`0x483.stldr`는 STM32CubeProgrammer에 포함된 ST 파일이라 이 저장소에서 배포하지 않습니다. ESP는 RAM stub이 프로그래머 펌웨어에 들어 있어 로더 파일이 필요 없습니다. `registry/loaders/st-0x483.toml`에는 지문만 기록합니다. SD 패키지 README와 사이트의 *SD 준비* 페이지에서 직접 복사하도록 안내합니다. 재배포가 허용된 로더는 `hosted = true`로 두고 파일을 함께 넣으면 패키지에 포함됩니다.
