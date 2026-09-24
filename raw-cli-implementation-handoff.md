# Bàn giao triển khai raw-cli

Tài liệu chuẩn: [build-raw-cli-plan.md](./build-raw-cli-plan.md), `loop-plan/v1`, bản **handoff-v2**. Đây là nguồn duy nhất quyết định contract, scope, thứ tự phase và điều kiện hoàn thành. File này giúp khởi động; không thay thế nội dung plan.

## Mục tiêu phải giữ

CLI nhẹ cho local model có context nhỏ: tiết kiệm prompt và schema, hỗ trợ nhiều nguồn LLM, có compact, giữ prefix ổn định để tái sử dụng cache qua nhiều lượt.

- Node 22+, TypeScript strict/ESM; package `raw-cli`, binary `raw`.
- Chạy full quyền tài khoản hiện tại, không sandbox.
- Đúng 3 primitive: `read_file`, `write_file`, `bash`; mở rộng qua MCP.
- SDK chính thức OpenAI/Anthropic/Google; thêm các endpoint tương thích, OpenRouter và Ollama qua adapter OpenAI.
- ACP là **Agent Client Protocol chuẩn**, không phải bộ method `acp.*` tự đặt; prompt phải nhận cả text và `resource_link` theo baseline v1, không tự fetch URI.
- Config profile có tên; `/compact`, `/clear`, `/stats`; one-shot, REPL và ACP stdio/WebSocket.
- Không thêm prompt ngầm, auto fallback, retry/summary/warm-up ngầm hoặc tool mặc định thứ tư.

## Hiện trạng thật

Tại thời điểm soạn handoff-v2 ban đầu, workspace chỉ có plan và tài liệu này. Trạng thái triển khai hiện tại nằm ở bảng **Progress Log** của plan và `docs/evidence/phase-N.md`; không suy ra tiến độ từ baseline lịch sử. Plan đã qua tự rà soát và `codex-plan-review` bằng `gpt-6-astra` sau khi sửa finding ACP v1 về `resource_link`.

CTXE trước đây báo Absent; preparation dừng vì các đường dẫn source dự kiến chưa tồn tại. Đọc Baseline trong plan để không lặp lại thao tác sai hoặc bịa rằng workspace đã được index.

## Cách bắt đầu và tiếp tục

1. Nhận chỉ thị triển khai rõ ràng của người dùng. Prompt mẫu bên dưới, nếu người dùng gửi, là đủ; không xin duyệt lại các quyết định đã ghi.
2. Đọc Target, Scope, Invariants, Baseline, toàn bộ D-contracts, Global Gates và Plan Review. Kiểm tra instruction/Git/tree hiện tại. Không yêu cầu phải có lịch sử chat này.
3. Dùng `$loop-implement` nếu có. Nếu môi trường không có skill, làm đúng G-00 trong plan; không bỏ workflow vì thiếu tên skill.
4. Bắt đầu phase chưa hoàn thành đầu tiên. Chỉ một phase `in_progress`. Đọc đủ mọi field của phase trước khi sửa file.
5. Docs -> test RED -> production code -> test GREEN -> cumulative gates -> implementation review -> evidence -> commit. Sau đó sang phase kế tiếp; không dừng sau scaffold/demo.
6. Khi bị ngắt hoặc chuyển agent, cập nhật Progress Log với phase, commit, command/test result thật và việc còn lại. Agent tiếp theo tiếp tục từ đó.

## 8 phase và bằng chứng chính

| Phase | Việc phải giao | Bằng chứng không được thay bằng lời khẳng định |
|---|---|---|
| 1 | Package, profile config, prompt | CLI config thật, precedence/credential tests, SDK import Node 22 |
| 2 | 3 primitive, policy, process cleanup | File/process thật; kill cả cây con; đo schema production |
| 3 | Provider SDK adapters | SDK thật gọi mock HTTP/SSE; fragmented calls, signatures, ảnh |
| 4 | Agent loop/state | Tool round-trip thật; max-step side-effect oracle; abort rồi tiếp tục hợp lệ |
| 5 | Compact/cache/usage | Rollback byte-identical; request-prefix comparison; cache metadata và usage đúng |
| 6 | MCP | 3 transport thật; selection/collision/pagination; ảnh vào payload thị giác |
| 7 | ACP/server/client | Official SDK client độc lập; text/resource-link prompt; reverse tool callback thật; cancel khi prompt đang chờ |
| 8 | CLI/package qualification | Cài tarball ngoài repo; chạy task/MCP/ACP; Node 22 và 24 thật |

Plan có **33 acceptance criteria**, mỗi tiêu chí có test ID hoặc inspection cụ thể. Chi tiết và lệnh chính xác nằm trong từng phase.

## Những cách làm tắt bị cấm

- Stub trả thành công, TODO trên đường public, giả model response, hoặc branch production nhận biết tên fixture.
- Chỉ mock `Provider.stream()` rồi tuyên bố official SDK hoạt động.
- Dùng cùng một transport giả rồi tuyên bố hỗ trợ stdio/SSE/HTTP.
- Chỉ đăng ký schema mà không thực thi reverse tool callback.
- Chỉ kill shell parent rồi báo đã hủy toàn bộ lệnh.
- Trả base64/đường dẫn dưới dạng text rồi nói model đã nhận ảnh.
- Gọi cache enabled nhưng không gửi control cần thiết; suy ra cache hit từ hash/latency; ghi unknown thành 0.
- Compact làm mất tool linkage, thay system prompt, hoặc xóa history khi summary lỗi/lớn hơn.
- `.skip`, `.todo`, `|| true`, chạy 0 test, bỏ suite, nới typecheck để vượt gate.
- Chạy từ source tree rồi coi như npm package đã được kiểm chứng; chỉ tạo YAML rồi nói CI đã pass.
- Đánh dấu phase complete khi thiếu AC, review hoặc evidence.

## Kết quả bàn giao cuối cùng

Các file chạy được, 8 phase commit, `docs/evidence/phase-N.md`, `docs/verification.md`, và Progress Log thật. Báo rõ Node/OS đã test, artifact/source hashes, gate results, platform/live-backend nào chưa chạy. Không publish npm, deploy hoặc tự tạo remote Git.

## Prompt người dùng có thể gửi cho agent triển khai

```text
Tôi duyệt và yêu cầu triển khai toàn bộ build-raw-cli-plan.md,
loop-plan/v1, bản handoff-v2, trong workspace raw-cli.

Dùng $loop-implement nếu có; nếu không, tuân thủ đầy đủ G-00 trong plan.
Đọc raw-cli-implementation-handoff.md để định hướng, nhưng plan là nguồn chuẩn.

Giữ nguyên các contract D-01..D-11 và invariants I-01..I-12.
Thực hiện đủ 8 phase và 33 acceptance criteria, theo đúng thứ tự dependency.
Docs trước, test RED trước production code, rồi GREEN, cumulative gates,
implementation review APPROVE, evidence và commit từng phase.

Không thay integration thật bằng mock nội bộ/stub, không bỏ test hoặc thu hẹp
scope để báo hoàn thành. Tiếp tục đến hết plan; nếu có blocker thật, ghi rõ
phase, bằng chứng, việc còn lại và quyết định cụ thể cần tôi cung cấp.
Không cần hỏi lại các lựa chọn tôi đã duyệt trong plan.
```
