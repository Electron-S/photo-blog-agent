# Manual Runbook

## Goal

Claude Code를 사용해 Blogger 글 품질과 운영 흐름을 검증합니다.

## Steps

1. 텔레그램에서 사진과 방문 메모를 보냅니다.
2. Claude Code가 사진을 분석하고 방문지를 파악합니다.
3. Claude Code가 방문지 공식 정보를 리서치합니다.
4. [input-template.md](input-template.md)를 참고해 Claude Code에 추가 정보를 제공합니다.
5. Claude Code가 이미지를 압축하고 GitHub Pages에 업로드합니다:
   ```bash
   node scripts/upload-images.js <이미지경로들> --slug <슬러그>
   ```
6. Claude Code가 프롬프트 파일을 읽고 Blogger 초안을 작성합니다.
7. Claude Code가 Blogger에 초안을 생성합니다:
   ```bash
   node scripts/create-draft.js --title "제목" --content ./draft.html --labels "라벨1,라벨2"
   ```
8. Blogger에서 사실관계, 사진 순서, 표현을 검수합니다.
9. 수정이 필요하면 Claude Code에 요청하고, 수정된 내용으로 업데이트합니다:
   ```bash
   node scripts/update-post.js --post-id ID --content ./revised.html
   ```
10. 발행 준비가 되면 공개합니다:
    ```bash
    node scripts/publish-post.js --post-id ID
    ```

## Success Criteria

```text
사진 세트 1개당 1개의 Blogger draft 생성
사진이 자동으로 본문에 삽입됨
확인 필요 사항이 명확히 분리됨
사진 기반 관찰 내용이 본문에 반영됨
랜드마크와 유명 장소가 정확한 명칭으로 표시됨
독자가 당연히 아는 사실이 가르치는 투로 표현되지 않음
외부 리뷰 원문 복사 없음
AdSense 리스크 문구 없음
수정 요청이 기존 Blogger 글에 반영됨
```