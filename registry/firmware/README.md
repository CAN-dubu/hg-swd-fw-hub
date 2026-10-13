# 펌웨어 등록

보통은 사이트의 **등록** 페이지에서 올립니다. 그러면 아래 파일이 자동으로 만들어져 PR로 올라갑니다. 이 문서는 직접 커밋할 때 참고하는 형식입니다.

폴더 하나가 프로젝트 하나, 그 아래 폴더 하나가 버전 하나입니다. 커밋해서 `main`에 올리면 CI가 검사한 뒤 사이트에 게시합니다.

```text
registry/firmware/
├── h723/                     프로젝트 ID = SD의 /prog/fw/<ID>/ 폴더명
│   ├── project.toml
│   └── 1.0.0/                버전 (x.y.z 또는 x.y.z-rc.1)
│       ├── release.toml
│       └── app.bin           STM32: 이미지 하나
└── esp32s3-rly4-pro/
    ├── project.toml
    └── 1.0.0/
        ├── release.toml
        ├── bootloader.bin    ESP: 이름이 정해진 세 파일
        ├── partitions.bin
        └── firmware.bin      ota-reset.bin은 넣지 않음 (CI가 생성)
                              또는 세 파일 대신 merged.bin 하나 (통파일)
```

`project.toml`

```toml
name        = "H723 GFX firmware"   # fw.txt name, 출력 가능한 ASCII 1~47자
chip        = "stm32h723"           # registry/chips/<chip>.toml: stm32h723, esp32, esp32s3, esp32c3
description = "H723 그래픽 데모"     # 사이트 표시용, 한글 가능
```

`release.toml`

```toml
date  = 2026-10-12      # 따옴표 없는 TOML 날짜
image = "app.bin"       # STM32만. 생략하면 app.bin
baud  = "auto"          # ESP만. auto(921600부터 검사), 921600, 460800, 230400, 115200
notes = """
- 변경 내용
"""
```

## 규칙

- 프로젝트 ID는 영문·숫자·`_`·`-` 1~24자입니다. 프로그래머가 표시하는 폴더명 규칙과 같습니다.
- STM32 BIN은 칩 Flash 시작 주소(H723은 `0x08000000`)의 벡터 테이블부터 시작하는 전체 이미지여야 합니다. 초기 SP와 Reset 벡터를 검사합니다.
- ESP는 빌드 결과의 `bootloader.bin`, `partitions.bin`, `firmware.bin`을 이름 그대로 넣습니다. 기록 주소는 칩이 정합니다. ESP32는 부트로더 `0x1000`, S3·C3는 `0x0`이고, 파티션 표 `0x8000`, 앱 `0x10000`입니다.
- 세 파일 대신 통파일(`esptool merge-bin`, `idf.py merge-bin`, Arduino의 `*.merged.bin`)을 `merged.bin` 이름으로 하나만 넣어도 됩니다. 파일 위치가 Flash 주소와 같아야 하며(`0x0`부터, ESP32는 `--target-offset 0x1000`도 가능), CI가 세 파일로 잘라 같은 `fw.txt`와 SD 패키지를 만듭니다. 부트로더·파티션 표·OTA data·앱 밖에 0xFF가 아닌 데이터(NVS, SPIFFS 등)가 있으면 기록되지 않으므로 거부합니다.

  | 방식 | 장점 | 단점 |
  | --- | --- | --- |
  | 3분할 | 빌드 폴더 결과물을 그대로 사용, 파일마다 검사 결과 확인 | 세 파일을 모두 골라야 하고 다른 빌드의 파일이 섞일 수 있음 |
  | 통파일 | 파일 하나, 빌드 간 혼용 없음, 받은 원본을 그대로 보관 | `0x0`부터 합친 파일만 가능, 다른 데이터가 있으면 불가, 빈 영역만큼 파일이 큼 |
- 이미지 `0x400`에 `VER ` 헤더가 있으면 내장 버전과 이름을 읽어 사이트에 표시합니다.
- 이미 게시한 버전 폴더는 고치지 말고 새 버전을 추가합니다. 기기는 버전 문자열로 변경 여부를 판단합니다. 단, SD zip과 그 안의 `README.txt`, `release.txt`는 CI가 매번 다시 만들므로 패키지 형식이 바뀌면 예전 버전 것도 함께 바뀝니다. 이미지와 `fw.txt`는 바뀌지 않습니다.
- `release.txt`(칩·버전)는 CI가 만듭니다. 버전 폴더에 직접 넣지 않습니다.
- 올리기 전에 로컬에서 `python tools/build_registry.py --check`로 검사할 수 있습니다.
