# Third-party notices

이 저장소의 코드(사이트, `tools/`, `tests/`, `registry/`의 칩·로더 설정)는 [MIT License](LICENSE)로 배포합니다.
`registry/firmware/` 아래의 펌웨어 바이너리는 이 라이선스에 포함되지 않으며, 프로젝트마다 아래 고지를 따릅니다.

## 사이트

| 구성 요소 | 사용 방식 | 라이선스 |
| --- | --- | --- |
| [Pretendard](https://github.com/orioncactus/pretendard) 1.3.9, Copyright (c) 2021, Kil Hyung-jin | jsDelivr CDN에서 불러옴. 저장소에 포함하지 않음 | SIL Open Font License 1.1 |

아이콘은 모두 이 저장소에서 직접 그린 SVG입니다. 외부 아이콘 세트를 쓰지 않습니다.
CI는 GitHub Actions(`actions/checkout`, `actions/setup-python`, `actions/upload-pages-artifact`, `actions/deploy-pages`)를 실행만 하며 재배포하지 않습니다.

## 펌웨어

각 펌웨어에 들어간 오픈소스의 저작권과 라이선스는 프로젝트 폴더의 `NOTICE.txt`에 있습니다. 버전 폴더에 `NOTICE.txt`가 있으면 그 버전에는 그것을 씁니다.
CI는 `NOTICE.txt`가 없거나 `TODO`가 남아 있으면 게시하지 않습니다.

| 프로젝트 | 고지 | 주요 구성 요소 |
| --- | --- | --- |
| `h723-gfx` | [NOTICE.txt](registry/firmware/h723-gfx/NOTICE.txt) | stm32h7-gfx (MIT, 원작자 허락을 받아 재배포), TouchGFX, STM32 HAL·USB·Audio·AcousticSL, CMSIS, FreeRTOS, FatFs, littlefs, newlib |
| `hg-esp32-s3` | [NOTICE.txt](registry/firmware/hg-esp32-s3/NOTICE.txt) | Arduino-ESP32 3.3.8 (LGPL-2.1), ESP-IDF v5.5.4, FreeRTOS, Mbed TLS, newlib |
| `hg-esp32-s3-rly4pro` | [NOTICE.txt](registry/firmware/hg-esp32-s3-rly4pro/NOTICE.txt) | Arduino-ESP32 3.3.10 (LGPL-2.1), ESP-IDF v5.5.4, FreeRTOS, Mbed TLS, newlib |

`NOTICE.txt`가 `licenses/<파일>`로 가리키는 라이선스 전문은 [registry/licenses/](registry/licenses/)에 있습니다. SD 패키지에는 그 프로젝트가 가리키는 전문만 `prog/licenses/`로 들어가고, 사이트는 모두 `licenses/`에 둡니다.

| 파일 | 내용 | 출처 |
| --- | --- | --- |
| `Apache-2.0.txt` | Apache License 2.0 | CMSIS 배포본의 LICENSE.txt |
| `LGPL-2.1.txt` | GNU LGPL 2.1 | Espressif 툴체인 `share/licenses/gcc/COPYING.LIB` |
| `MIT.txt`, `BSD-3-Clause.txt` | 허가 문구 (저작권 줄은 각 NOTICE.txt에) | SPDX 표준 문구 |
| `newlib.txt` | newlib의 개별 라이선스 모음 | Espressif 툴체인 `share/licenses/newlib/COPYING.NEWLIB` |
| `ST-SLA0044.txt`, `ST-SLA0047.txt`, `ST-SLA0077.txt` | STMicroelectronics 소프트웨어 라이선스 | 각 ST 라이브러리 배포본의 LICENSE 파일 |
