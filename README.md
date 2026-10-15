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

HUD tự scale trong khung dọc và chừa vùng an toàn cho giao diện TikTok; quà có hàng đợi riêng, feed giữ 5 dòng. Bật âm thanh bằng nút loa hoặc `?audio=1` cho OBS; nếu trình duyệt chặn autoplay, cần tương tác một lần. Nút nốt nhạc bật/tắt riêng nhạc nền điện tử tự tổng hợp bằng Web Audio (không cần file nhạc hay tải bên ngoài); khi toàn bộ âm thanh đang tắt, bấm nốt nhạc sẽ bật âm thanh và nhạc nền. Nhạc lặp với giai điệu/bass và nhịp thay đổi theo phase; cấu hình ở `config.audio.music`. Nút loa tắt cả nhạc và hiệu ứng, thanh âm lượng điều chỉnh chung. Nhạc tạm dừng khi tab ẩn, không phát bù các nốt bị lỡ. Âm lượng mặc định nằm trong config.audio, có slider trên HUD. Dùng `?connection=0` để ẩn chỉ báo kết nối. Bảng ngày lấy từ `/api/leaderboard`, reset theo ngày UTC; bảng all-time giữ nguyên và dữ liệu được lưu JSON để tồn tại qua restart.

### Giao diện rừng neon
- Nền lấy từ `client/assets/backgroud.png` (giữ đúng tên file hiện tại), hiển thị kiểu cover để không kéo méo ảnh. `?transparent=1` vẫn bỏ nền rừng cho OBS.
- Nhân vật lấy từ `client/assets/sprite/`: kiếm sĩ 13/16, pháp sư 17/18, cung thủ 29/31, tank 23/24; boss dùng ảnh 12. Các cặp ảnh đổi tư thế khi di chuyển/tấn công, không phải sprite sheet animation đầy đủ. Avatar người xem vẫn dùng ở HUD/xếp hạng.
- Ảnh sprite hiện có nền ô caro in sẵn. Renderer xóa vùng nền sáng trung tính nối với mép ảnh khi tải, không sửa file gốc; nên thay bằng PNG alpha thật để giữ hoàn hảo các chi tiết sáng/viền nhân vật. Không dùng tên và thanh máu in sẵn; tên, HP và trạng thái được vẽ từ game state.
- HUD có tiến trình vòng, top sát thương, năng lượng sự kiện, tổng kim cương trong ván và feed; đã bỏ bản đồ nhỏ và cụm icon/mô tả skill để thoáng đấu trường. Icon quà được cắt từ ảnh mẫu; nhãn lệnh/giá quà lấy từ cấu hình, không phải nút điều khiển hay số liệu livestream giả.
- Khung thiết kế 1080 × 1920, HUD tự scale khi đổi cửa sổ. Dải lệnh/quà ở đáy luôn hiển thị; trong OBS nên dùng Browser Source 1080 × 1920 và kiểm tra vùng chồng lấp giao diện LIVE của nền tảng.
- Trong BATTLE/FINAL, dưới hai cột Lệnh nhanh / Chọn quà TikTok là dải ba ô: số người còn sống và số ván, năng lượng sự kiện, tổng quà trong ván. HP boss (khi xuất hiện) nằm ở hàng riêng toàn chiều ngang ngay dưới dải này. Giữ nguyên nội dung, số liệu và thanh progress; không còn panel chỉ số/boss nổi bên phải map.
- Footer dùng lệnh/thẻ quà thu gọn, ba thẻ chỉ số có viền màu riêng và thanh HP boss ngang gọn; ưu tiên đọc số liệu trận mà không tăng vùng che map.

### Nhịp trận và hiệu ứng thời tiết
- Khi COUNTDOWN kết thúc, người chơi được rải ngẫu nhiên trong bản đồ và vùng bo ban đầu, có chừa mép. `config.spawn` điều chỉnh khoảng cách mong muốn (110 px) và số lần thử; bản đồ quá nhỏ/đông sẽ chọn điểm tốt nhất tìm được thay vì lặp vô hạn. Cây/đá trong ảnh nền chỉ là trang trí, không có collision địa hình.
- HP: kiếm sĩ 240, cung thủ 180, pháp sư 160, tank 400 (gấp đôi bản trước). Giao tranh tối đa 240 giây + chung kết 60 giây; lịch bo kéo dài tới giây 287. Vẫn kết thúc sớm khi chỉ còn một người; vào FINAL sớm không rút ngắn hạn cuối tổng 300 giây.
- Bão có mưa xiên, lớp tối và chớp/sét trong đúng thời gian sự kiện; sát thương bão vẫn chỉ cộng vào người ngoài bo. Thiên thạch có vòng báo đúng bán kính sát thương, vệt lửa rơi và nổ; các viên rơi lần lượt trong thời gian sự kiện và chỉ gây sát thương khi chạm đất, không nổ sớm khi người chơi bước vào vùng cảnh báo. Mưa bom/bẫy thường giữ nguyên hành vi cũ.
- Boss không tạo thêm người chơi. Quà Tier 4 có thể hồi sinh một người cũ và đồng thời nạp đầy năng lượng để gọi boss. Boss và người hồi sinh nay tìm điểm trống trong bo, tránh người đang sống/boss hiện tại; HUD có banner hồi sinh riêng để phân biệt. Bo quá nhỏ/đông sẽ cảnh báo console và chọn điểm tốt nhất có thể. Boss có chuyển động nhún khi di chuyển, lắc thân/lao tới và vệt chém khi đòn đánh thực sự gây sự kiện damage; đây là animation từ ảnh tĩnh, không phải sprite sheet mới. Chu kỳ đánh/sát thương/thưởng giữ nguyên.

### Boss nguyên tố và ván thảo phạt
- Mỗi ván thường bảo đảm **đúng một** boss nhỏ ngẫu nhiên trong bốn boss **Lửa, Băng, Rừng, Hắc Ám**: xuất hiện ở giây 20 giao tranh nếu chưa được sự kiện gọi sớm. Tự gọi sớm khi có người chết và chỉ còn tối đa 4 người, hoặc bắt đầu trận chỉ có một người; không cần đủ 4 người cho lượt triệu hồi bắt buộc. Khi chỉ còn một người mà boss vẫn sống, ván tiếp tục đến khi người hoặc boss chết, nhưng không vượt hạn tổng 300 giây. Boss chết không sinh lại trong cùng ván. Ván thảo phạt chỉ có Hợp Thể, không có boss nhỏ. Giữ thưởng hồi máu/rage cho người gây nhiều sát thương.
- HP bốn boss nhỏ giảm 30% so với bản trước (Lửa 1050, Băng 1155, Rừng 1207,5, Hắc Ám 997,5 với HP gốc 1500). Thời gian đầy mana tăng ×1,5: lần lượt 15 / 18 / 19,5 / 16,5 giây. Boss Hợp Thể tăng 50% HP, giữ nguyên nhịp mana. Mỗi boss có HP/ATK/tốc độ riêng, mana từ 0 và một skill tự dùng khi đầy:
  - **Lửa — Địa ngục dung nham:** sát thương diện rộng quanh boss.
  - **Băng — Băng chấn:** sát thương quanh boss và làm chậm 3 giây.
  - **Rừng — Cội nguồn sinh mệnh:** sát thương quanh boss và hồi 6% HP tối đa cho boss.
  - **Hắc Ám — Hố đen:** khóa vị trí mục tiêu gần nhất, gây nổ và kéo người trong vùng vào tâm.
  - **Hợp Thể — Tứ nguyên hủy diệt:** kết hợp sát thương diện rộng, làm chậm, hồi HP và kéo mục tiêu; hiệu ứng đủ bốn màu nguyên tố.
- Mỗi ván **3, 6, 9…**, Boss Hợp Thể xuất hiện ngay khi COUNTDOWN kết thúc. HP bằng `9750 + 300 × số người sống` lúc triệu hồi, ATK 42; cấu hình trong `config.bosses`. Toàn đội chỉ tìm/đánh boss, kể cả bot và skill class. Chặn sát thương người chơi lên người chơi ở lớp combat, khóa phản bội; quà ultimate đánh boss thay vì đồng đội. Không thu bo, không sinh thời tiết/bẫy/boss phụ trong ván thảo phạt; quà, cứu, hồi sinh, né và tiếp tế vẫn hoạt động. AI chủ động chạy khỏi vòng báo skill boss.
- Skill boss có vòng báo trước 1,3–1,8 giây, sau đó mới gây sát thương tại vị trí đã báo; boss dừng di chuyển/tấn công khi niệm. Tên boss, tên skill, HP và mana hiển thị trên HUD; trên bản đồ có mana, hào quang nguyên tố, chuyển động chiến đấu và hiệu ứng nổ kỹ năng.
- Hạ boss kết thúc ván ngay: người **kết liễu** được xếp đầu và vinh danh “ANH HÙNG DIỆT BOSS”, không phải người gây tổng sát thương cao nhất. Nhận **+25% HP tối đa, +20% ATK** cùng vương miện/hào quang **DIỆT BOSS** trên đầu trong đúng ván kế tiếp; không cộng dồn và đổi class trước trận vẫn giữ đúng hệ số thưởng. Nếu bot kết liễu, giữ bot đó đúng một ván để nhận thưởng.
- Còn một người vẫn tiếp tục đánh boss. Hết **240 giây** hoặc toàn đội chết là thất bại, không chọn người thắng bằng HP và không trao buff; tiếp tục vòng kế tiếp bình thường.
- Ảnh PNG alpha trong `client/assets/boss/`: Lửa `asset-1_34.png`, Băng `asset-4_41.png`, Rừng `asset-3_27.png`, Hắc Ám `asset-2_44.png`, Hợp Thể `asset-5_36.png`. Renderer giữ nguyên alpha và toàn bộ hình, không cắt theo thẻ cũ, không bo oval hoặc xóa các chi tiết sáng; giữ đúng tỷ lệ ảnh.
- Đòn đánh boss phát sprite chém theo hướng mục tiêu khi combat thực sự đánh. Skill có sprite lửa, mảnh băng, dây leo, xoáy tối và hợp thể bốn màu tại thời điểm impact; vòng cảnh báo vẫn giữ nguyên bán kính gameplay. `client/render/bossEffectSprites.js` tự rasterize sprite sheet alpha 8 frame/action/boss và cache tối đa 10 sheet trong renderer, không tải tài nguyên ngoài, không tạo lại mỗi frame; dispose giải phóng cache. Hiệu ứng không đổi damage, mana, thời gian skill hoặc buff.

### Di chuyển, mana và kỹ năng class
- Lệnh nhanh có `JOIN [class]`: `JOIN Kiếm sĩ`, `JOIN Cung thủ`, `JOIN Pháp sư`, `JOIN Tank` (không dấu, chữ hoa/thường hoặc ID `swordsman/archer/mage/tank` đều được). `JOIN` không kèm class cho người mới chọn ngẫu nhiên theo cơ chế cân bằng class hiện tại; người đã tham gia không bị random lại. Có thể chọn/đổi class trong LOBBY và COUNTDOWN, kể cả người được tự thêm khi vào phòng LIVE; khi giao tranh bắt đầu thì khóa class. Class không hợp lệ không làm người mới tự join ngẫu nhiên. Mock server và `?local=1` luân phiên JOIN thường và JOIN chọn đủ bốn class qua bình luận thật.
- Sảnh chờ có bảng giới thiệu 4 class: vai trò, HP/ATK/DEF cơ bản, tên và tác dụng skill, cùng hướng dẫn mana. Chỉ số và thông số skill lấy từ cấu hình; bảng ẩn cùng sảnh khi bắt đầu đếm ngược, không hiển thị trong trận.
- Nhân vật chủ động tìm đối thủ, đi vòng trong tầm đánh thay vì đứng yên; thấp hơn 30% HP sẽ giữ khoảng cách/chạy trốn. Hướng chạy được đẩy vào trong khi gần mép map/bo, kể cả lúc né; vẫn ưu tiên vào bo và nhặt tiếp tế. Đây là hạn chế bám mép, không phải vùng cấm đi vào.
- Thanh xanh dương dưới HP là mana: bắt đầu từ 0, đầy sau 15 giây BATTLE/FINAL, giữ ở mức 100 nếu chưa có địch trong tầm. Đủ mana tự dùng đúng một skill rồi về 0; chết, hồi sinh và ván mới reset mana. Không hồi ở sảnh, đếm ngược hoặc kết quả.
- Kiếm sĩ **Lốc kiếm**: chém xoáy bán kính 145, sát thương 1,4 × ATK lên mỗi địch.
- Cung thủ **Liên tiễn**: ba phát vào một mục tiêu trong tầm 340, mỗi phát 0,65 × ATK.
- Pháp sư **Bộc phá**: chọn địch trong tầm 300, nổ bán kính 125 quanh mục tiêu, sát thương 1,6 × ATK lên mỗi địch.
- Tank **Hộ thể**: có địch trong 200 thì nhận 20 khiên trong 4,5 giây và hồi 4% maxHP (không vượt maxHP). Dùng pipeline buff/khiên hiện có, vẫn chịu giới hạn buff chung.
- ATK skill tính cả buff/vũ khí/liên minh, không crit, bỏ qua DEF nhưng vẫn bị khiên hấp thụ và bất tử hồi sinh chặn. Skill không đánh đồng minh khi tắt friendly-fire; skill tấn công đánh được boss, ghi damage/kill/thưởng theo hệ thống combat chung. Thông số và công tắc nằm ở `config.skills`.
- HP mất có số âm viền đậm, chớp đỏ và vệt thanh máu vàng giảm chậm; khiên là hào quang xanh cùng các hạt quay quanh người. Mỗi skill có tên và hiệu ứng riêng.
- Kết quả có cúp, hào quang, giấy kim tuyến, thẻ vô địch và bục top 3. Khi có người thắng, nhạc đổi sang giai điệu/bass chúc mừng riêng; hòa không phát nhạc chiến thắng. Nhạc vẫn tuân theo nút nhạc/loa, âm lượng và trạng thái tab. Hoạt ảnh HUD tôn trọng `prefers-reduced-motion`.
- Không còn lệnh ĐÁNH / TẤN CÔNG / ATTACK hay buff từ lệnh này. Nhân vật vẫn tự đánh đúng tốc độ class, dùng skill khi đầy mana; giữ các lệnh JOIN, NÉ, HỢP TÁC, PHẢN BỘI và CỨU.

### Dữ liệu hành động mock
- Cả mock server (`USE_MOCK=true`) và mock trình duyệt (`?local=1`) có chuỗi bình luận phối hợp: hai người mời hợp tác qua lại, dùng NÉ định kỳ, rồi một người PHẢN BỘI sau thời gian chờ ít nhất 15 giây. Mỗi khoảng 28 giây chuyển sang cặp khác; server dùng tên có số thứ tự để không nhầm mục tiêu trùng tên.
- Sau lệnh phản bội 3 giây, người gửi comment **CỨU [tên người cùng cặp]** rồi gửi quà ngay tiếp theo. Các chu kỳ luân phiên quà T1 (hồi HP) và T4 (có thể hồi sinh người đã chết, theo giới hạn hiện có). Mock không cố tình giết nhân vật để tạo hồi sinh; nếu mục tiêu còn sống, T4 giữ hành vi gameplay hiện có.
- Đây là bình luận đi qua input/gameplay thật, không ép sự kiện liên minh hoặc bỏ qua luật. Ở sảnh chưa được né/phản bội; người đã chết, chưa vào trận hoặc không còn đồng minh có thể bị từ chối như người chơi thật. Chuỗi tiếp tục trong trận để tạo tình huống quan sát được; chat/quà/like ngẫu nhiên vẫn giữ.

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
