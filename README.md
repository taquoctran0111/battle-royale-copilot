# Đấu Trường Sinh Tồn – Server

Server Node.js (ESM) phục vụ `client/` tĩnh, WebSocket cùng port, và cầu nối TikTok LIVE.

## Chạy nhanh
```bash
npm install
npm test
npm run test:audit          # catalog + payload adapter
npm run test:e2e            # mock tích hợp + soak tăng tốc
npm start                   # mở http://localhost:3000
```
Cần Node >= 18. Chạy thật: `USE_MOCK=false TIKTOK_USERNAME=ten_host npm start` (host phải đang LIVE).

Trên PowerShell, bật mock bằng `$env:USE_MOCK='true'; npm start`. Trang game là `/`; trang kiểm tra core là `/test.html`. Khi cổng 3000 đã có server chạy, dừng server cũ hoặc chọn cổng khác bằng `$env:PORT='3100'` trước khi chạy.

Thử quà trên `/mock.html` của cùng server với game, ví dụ `http://localhost:3000/mock.html`. Chọn người gửi khớp với chiến binh trong game rồi bấm Quà T1–T4; trang hiển thị người gửi thực tế hoặc lỗi API. Nút “Mở game” mở đúng backend đang nhận quà. T1 hồi máu không làm tăng HP vượt maxHp; T1/T2 không hồi sinh người đã chết, cần T4.

Game mở bằng Live Server tự kiểm tra `/health` để tìm backend, mặc định cổng 3000. Với backend ở cổng khác, truyền `?server=http://localhost:3100` cho cả trang game và trang mock. Không dùng `?local=1` khi thử quà từ server: chế độ đó không kết nối WebSocket thật.

Hiệu ứng quà chỉ áp trong BATTLE/FINAL; ở LOBBY/COUNTDOWN/RESULT quà chỉ cộng giftValue cho người tặng. Tier1–3 gửi tới spectator hoặc người chưa join bị bỏ qua; tier4 chuyển ultimate. Giới hạn hồi sinh là gifts.maxRevivesPerRound và một lần mỗi người/ván; cap buff nằm trong gifts.buffCaps của cấu hình.

HUD tự scale trong khung dọc và chừa vùng an toàn cho giao diện TikTok; quà có hàng đợi riêng, feed giữ 5 dòng. Bật âm thanh bằng nút loa hoặc `?audio=1` cho OBS; nếu trình duyệt chặn autoplay, cần tương tác một lần. Âm lượng mặc định nằm trong config.audio, có slider trên HUD. Dùng `?connection=0` để ẩn chỉ báo kết nối. Bảng ngày lấy từ `/api/leaderboard`, reset theo ngày UTC; bảng all-time giữ nguyên và dữ liệu được lưu JSON để tồn tại qua restart.

## Biến môi trường
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3000 | Cổng HTTP + WS |
| `TIKTOK_USERNAME` | – | Host đang LIVE (không cần `@`) |
| `USE_MOCK` | false | `true` = dùng sự kiện giả; thiếu username cũng tự dùng mock |
| `MOCK_INTENSITY` | medium | `low` / `medium` / `high` |
| `TIKTOK_SIGN_API_KEY` | – | Tuỳ chọn, Euler sign key |
| `LEADERBOARD_FILE` | data/leaderboard.json | Ghi đè đường dẫn file leaderboard, hữu ích khi test/triển khai |

## WebSocket
Mọi client nhận JSON `{ "type": "live:chat", "payload": {...} }` (schema theo HỢP ĐỒNG CHUNG).
Client mới kết nối được gửi ngay `live:status` hiện tại. Like được gộp: tối đa 1 sự kiện `live:like` mỗi 250ms (likeCount cộng dồn, userId/nickname của người like gần nhất).

## API
- `GET /api/leaderboard?period=day&metric=wins&limit=5` – period: day/week/all; metric: wins/kills/giftValue; limit: 1–100. Mặc định day/wins/5, trả mảng { userId, name, avatar, wins, kills, damage, giftValue, rounds, lastSeen }.
- `POST /api/leaderboard` – payload round:ended, có thể thêm sessionId và avatar/giftValue trong mỗi hàng ranking. Bỏ bot_, kiểm tra số liệu/placement/ID, body tối đa 100 KB; dữ liệu sai trả 400, quá lớn trả 413.
- Chỉ khi mock: `POST /mock/send`, `POST /mock/intensity`, `GET /mock/status`.

```bash
curl -X POST localhost:3000/mock/send -H 'Content-Type: application/json' \
  -d '{"type":"live:gift","payload":{"giftName":"Galaxy","diamonds":1000,"count":1}}'
curl -X POST localhost:3000/mock/intensity -H 'Content-Type: application/json' -d '{"intensity":"high"}'
```
`/mock/send` nhận type: `live:chat|gift|like|join|follow|share`; trường thiếu tự điền bằng người dùng ảo.

## Lưu Leaderboard

File data/leaderboard.json được tạo tự động ở lần ghi đầu tiên. Store có addRoundResult(ranking) (cũng nhận toàn bộ payload round:ended) và getTop({period,metric,limit}); ngày UTC, tuần UTC bắt đầu thứ Hai. Chuyển ngày/tuần chỉ reset bucket tương ứng, không xóa all-time hoặc khóa chống cộng trùng. Client chụp avatar/giftValue từ state ngay lúc round:ended, POST kèm sessionId; HUD gọi fetchTop() từ module network. Lỗi mạng không làm dừng game.

Mỗi thao tác được serialize theo đường dẫn file trong **một tiến trình Node**; ghi file .tmp cùng thư mục, fsync, đóng file rồi rename. Hai store cùng đường dẫn trong cùng tiến trình dùng chung khóa. Không chạy nhiều Node process ghi chung file này; dùng database/shared locking khi triển khai nhiều instance. File JSON hỏng trả lỗi và giữ nguyên để phục hồi, không tự ghi đè. Sao lưu thư mục data để giữ lịch sử; không đưa dữ liệu người chơi vào source control.

## Ghi chú
- main khởi tạo module theo hợp đồng; tick cố định 30 Hz với thứ tự Round/Gift/Alliance/Zone/Event/Movement/Combat. Tab ẩn không tích lũy bước bù, system lỗi liên tục bị disable riêng.
- ?local=1 giả lập không cần TikTok, ?debug=1 log bus, ?audio=1 bật audio, ?w=&h= đổi nguồn (tối đa 4096 mỗi chiều), ?transparent=1 bỏ nền cho OBS. HUD giữ khung thiết kế dọc khi đổi resolution.
- Soak 30 phút Node thực: `node --expose-gc scripts/mock-e2e.js --realtime`. Mặc định test:e2e chỉ tăng tốc 30 phút logic; heap/FPS Chromium/OBS cần kiểm tra thực theo TESTING.md.
- Checklist E2E và phạm vi test tự động: [TESTING.md](TESTING.md).
- Adapter dùng `tiktok-live-connector` 2.5.0 (`TikTokLiveConnection`, user ở `data.user`; vẫn đọc được `data.uniqueId`).
- Quà streak (`giftType===1`) chỉ phát khi `repeatEnd`, `count=repeatCount`, `diamonds=đơn giá*count`.
- Reconnect backoff 2s,4s,8s… tối đa 30s; mỗi thay đổi đều phát `live:status`.
