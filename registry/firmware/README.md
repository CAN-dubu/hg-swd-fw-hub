# 펌웨어 등록

보통은 사이트의 **등록** 페이지에서 올립니다. 그러면 아래 파일이 자동으로 만들어져 PR로 올라갑니다. 이 문서는 직접 커밋할 때 참고하는 형식입니다.

폴더 하나가 프로젝트 하나, 그 아래 폴더 하나가 버전 하나입니다. 커밋해서 `main`에 올리면 CI가 검사한 뒤 사이트에 게시합니다.

```text
registry/firmware/
└── h723-gfx/                 프로젝트 ID = SD의 /prog/fw/<ID>/ 폴더명
    ├── project.toml
    └── 1.0.0/                버전 (x.y.z 또는 x.y.z-rc.1)
        ├── release.toml
        └── app.bin
```

`project.toml`

```toml
name        = "H723 GFX firmware"   # fw.txt name, 출력 가능한 ASCII 1~47자
chip        = "stm32h723"           # registry/chips/<chip>.toml
description = "H723 그래픽 데모"     # 사이트 표시용, 한글 가능
```

`release.toml`

```toml
date  = 2026-10-12      # 따옴표 없는 TOML 날짜
image = "app.bin"       # 생략하면 app.bin
notes = """
- 변경 내용
"""
```

## 규칙

- 프로젝트 ID는 영문·숫자·`_`·`-` 1~24자입니다. 프로그래머가 표시하는 폴더명 규칙과 같습니다.
- BIN은 칩 Flash 시작 주소(H723은 `0x08000000`)의 벡터 테이블부터 시작하는 전체 이미지여야 합니다. 초기 SP와 Reset 벡터를 검사합니다.
- 이미지 `0x400`에 `VER ` 헤더가 있으면 내장 버전과 이름을 읽어 사이트에 표시합니다.
- 이미 게시한 버전 폴더는 고치지 말고 새 버전을 추가합니다. 기기는 버전 문자열로 변경 여부를 판단합니다.
- 올리기 전에 로컬에서 `python tools/build_registry.py --check`로 검사할 수 있습니다.
