# 누끼 — 로컬 전용 자동 배경 제거

이미지(인물·사물)의 배경을 **브라우저 안에서** 자동으로 제거하는 웹앱(PWA)입니다.

**바로 사용: https://gunwoo-jung.github.io/nuggi/** (PC·모바일 브라우저, 홈 화면에 추가 가능)

## 개인정보 보호 설계

- **업로드 없음**: AI 모델(ONNX)이 브라우저의 WebAssembly로 기기에서 직접 실행됩니다. 이미지 데이터를 서버로 보내는 코드가 없습니다.
- **브라우저 차원의 차단**: `Content-Security-Policy: connect-src 'self'`로 외부 서버 통신을 막습니다. 외부 CDN, 분석 도구, 폰트도 없고 모든 파일을 이 폴더에서 직접 제공합니다.
- **저장 안 함**: 이미지는 메모리(canvas, blob URL)에만 있고 localStorage, IndexedDB, 캐시에 쓰지 않습니다. 새로고침하거나 탭을 닫거나 "모두 지우기"/"삭제"를 누르면 사라집니다. 파일은 사용자가 "PNG 저장"을 누를 때만 기기에 저장됩니다.
- **오프라인 동작**: 처음 열면 서비스 워커가 앱 코드와 모델을 캐시합니다. 사용자 이미지는 캐시하지 않습니다. 그 후에는 비행기 모드에서도 동작합니다.
- 서버(`serve.py`)는 정적 파일만 제공하며 POST, PUT 등 업로드 요청은 405로 거부합니다.

## 실행

```bash
python3 serve.py           # http://localhost:8000
python3 serve.py --lan     # 같은 Wi-Fi의 휴대폰에서 http://<PC IP>:8000 으로 접속
```

Python 3만 있으면 되고 빌드나 설치 과정은 없습니다.

### 모바일

- 사내 정적 웹서버나 GitHub Pages 같은 **HTTPS 정적 호스팅**에 폴더를 그대로 올리면 휴대폰 브라우저에서 바로 쓸 수 있습니다. 이 경우에도 이미지는 휴대폰 안에서만 처리됩니다. 서버는 앱 파일만 내려줍니다.
- 브라우저 메뉴에서 "홈 화면에 추가"를 누르면 앱처럼 설치되고 오프라인에서도 동작합니다.
- `--lan`(http)으로 접속하면 서비스 워커(오프라인 캐시)가 비활성화되지만 배경 제거는 정상 동작합니다.
- 결과는 "공유·사진에 저장"(iOS/Android 공유 시트) 또는 "PNG 저장"으로 저장합니다.
- 멀티스레드 가속을 쓰려면 호스팅에서 `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` 헤더를 보내야 합니다(`serve.py`는 기본으로 보냄). 헤더가 없으면 단일 스레드로 동작해 조금 느립니다.

## 기능

- **모드**
  - 일반(전신·사물, 권장): ormbg, 44MB, 1024×1024 입력
  - 얼굴·상반신(빠름): MODNet, 7MB. 상반신 인물 사진용으로 학습돼 전신 사진에서는 다리가 지워질 수 있습니다.
- **정밀 보정**(기본 켜짐): ViTMatte가 머리카락·털 경계를 한 번 더 다듬고 가장자리에 비친 배경색을 제거합니다. 처음 사용할 때 모델 27MB를 추가로 받고, 처리 시간이 늘어납니다. 끄면 기존 모델 결과만 사용합니다.
- **배경**: 투명, 흰색, 검정, 원하는 색. 저장할 때 적용됩니다.
- **잔여물 제거**(기본 0%): 가장자리에 남은 흐릿한 배경 흔적(그림자, 배경색 번짐)을 지웁니다. 0/25/50/75/100% 버튼이나 슬라이더·숫자 입력으로 조절합니다. 높일수록 가는 머리카락도 함께 지워질 수 있습니다. 모델을 다시 돌리지 않고 바로 반영됩니다.
- 비교 슬라이더(원본↔결과), 여러 장 동시 처리, 드래그 앤 드롭, 붙여넣기
- 1,600만 화소가 넘는 이미지는 iOS 캔버스 한도 때문에 그 이하로 축소해 처리합니다.

## 구성

| 파일 | 역할 |
|---|---|
| `index.html`, `style.css`, `app.js` | UI, 전처리, 마스크 합성, 저장 |
| `worker.js` | Web Worker에서 onnxruntime-web으로 추론 |
| `sw.js` | 앱 파일과 모델의 오프라인 캐시 |
| `models/` | `ormbg.onnx`(quantized), `modnet.onnx`(uint8), `vitmatte.onnx`(quantized) |
| `vendor/` | onnxruntime-web 1.31.1 (wasm) |

## 라이선스 (서드파티)

- ormbg — Apache-2.0 — https://huggingface.co/onnx-community/ormbg-ONNX (원본: schirrmacher/ormbg)
- MODNet — Apache-2.0 — https://huggingface.co/Xenova/modnet (원본: ZHKKKe/MODNet)
- ViTMatte — Apache-2.0 — https://huggingface.co/hustvl/vitmatte-small-composition-1k (ONNX via Xenova)
- onnxruntime-web — MIT — https://github.com/microsoft/onnxruntime

모두 상업적으로 사용할 수 있는 라이선스입니다. RMBG-1.4(비상업)와 ISNet ONNX 배포본(AGPL)은 라이선스 때문에 쓰지 않았습니다.
