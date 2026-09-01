# Manual Runbook

## Goal

Claude Code를 사용해 Blogger 글 품질과 운영 흐름을 검증합니다.

## Steps

명령과 플래그의 정본은 [README.md](../README.md)이고, 워크플로우 Step 1~7의 정본은
[prompts/workflow-steps.md](../prompts/workflow-steps.md)입니다. 여기서 다시 적지 않습니다.

이 문서는 `/blog` 자동 흐름을 쓰지 않고 손으로 진행할 때의 순서만 남깁니다:

```text
1. EXIF 추출        node scripts/extract-exif.js <사진들> --output tmp/metadata-<날짜>.json
2. 시각 분석 골격    node scripts/analyze-photos.js <사진들> --output tmp/photo-analysis-<날짜>.json
3. 업로드           node scripts/upload-images.js <사진들> --metadata ... --slug ... --output ...
4. 리서치           manual-workflow/input-template.md 참고
5. 초안 작성        prompts/blog-draft.md + style-guide.md + system-rules.md
6. 초안 검증        node scripts/lint-draft.js tmp/draft-<slug>.html --upload-result ...
7. 초안 등록        node scripts/create-draft.js --title ... --content ... --labels ...
8. 수정 루프        node scripts/update-post.js --post-id ... --content ...
9. 발행             node scripts/publish-post.js --post-id ... --slug-from-date ...
```

## Success Criteria

(`workflow/agent-flow.md`와 동일한 기준입니다.)

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
