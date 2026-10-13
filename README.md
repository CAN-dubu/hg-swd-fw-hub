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
├── loaders/<loader>.toml      STM32 Flash 로더 지문(크기, CRC32, SHA-256). 파일은 배포하지 않음
└── firmware/<id>/             프로젝트 = SD의 /prog/fw/<id>/
    ├── project.toml
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
| `fw/<id>/<ver>/<id>-<ver>-sd.zip` | `prog/` 폴더째 SD 루트에 푸는 패키지 |

`latest.txt` 예(ESP):

```ini
schema=1
id=esp32s3-rly4-pro
chip=esp32s3
version=1.0.0
date=2026-10-07
base=fw/esp32s3-rly4-pro/1.0.0/
file=bootloader.bin,19984,0x6AA603B4,b41be55a…
file=partitions.bin,3072,0xF03E088A,ace02503…
file=ota-reset.bin,8192,0xB4293435,7d2c7ac4…
file=firmware.bin,367024,0x86B519A4,e271109b…
file=fw.txt,287,0xE8476B59,8febb699…
```

`file=이름,크기,CRC32,SHA-256` 줄마다 `base` + 이름으로 받습니다. STM32는 `app.bin`과 `fw.txt` 두 줄입니다. **`fw.txt`는 항상 마지막 줄이고, SD에도 마지막에 씁니다.** 그래야 중간에 끊긴 복사본이 선택 가능한 프로젝트로 보이지 않습니다. 경로는 사이트 루트 기준이고, 게시한 버전 폴더는 바꾸지 않습니다. `schema` 값이 바뀌면 호환되지 않는 변경입니다.

## 검사 항목

규칙은 HG-SWD-PROG의 `prog.c`, `prog_inspect.c`, `esp_project.c`, `prepare_esp_sd.py`와 같습니다. 웹 등록 페이지도 같은 검사를 브라우저에서 먼저 보여 줍니다.

공통

- 프로젝트 ID: `A-Z a-z 0-9 _ -` 1~24자
- 이름: 출력 가능한 ASCII 1~47자. `fw.txt`는 1,024바이트 이하
- 버전 폴더: `x.y.z` 또는 `x.y.z-tag`. 태그가 붙은 버전은 프리릴리스이며 `latest`에서 제외

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

## 로더 라이선스

`0x483.stldr`는 STM32CubeProgrammer에 포함된 ST 파일이라 이 저장소에서 배포하지 않습니다. ESP는 RAM stub이 프로그래머 펌웨어에 들어 있어 로더 파일이 필요 없습니다. `registry/loaders/st-0x483.toml`에는 지문만 기록합니다. SD 패키지 README와 사이트의 *SD 준비* 페이지에서 직접 복사하도록 안내합니다. 재배포가 허용된 로더는 `hosted = true`로 두고 파일을 함께 넣으면 패키지에 포함됩니다.
