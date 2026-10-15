# Kiểm thử tích hợp

## Tự động hóa

Chạy `npm test` với Node.js 18 trở lên. Bộ `node:test` trong `tests/game-smoke.test.js` hiện kiểm tra:

- [x] Core EventBus, chuẩn hóa tiếng Việt và tìm người chơi không phân biệt dấu.
- [x] Parser alias có dấu/không dấu, hoa thường, punctuation, emoji, `@name` và command phải ở đầu comment.
- [x] Cooldown theo người chơi, token bucket toàn cục, join gate và rescue target.
- [x] Quà tự join, map target/energy đúng schema; tier 4 ưu tiên hồi sinh đúng target.
- [x] GiftValue thuộc người tặng, heal nhân count có cap, shield/weapon giới hạn, bounty không nhận shield quà T2, hàng tiếp tế gần người nhận.
- [x] Renderer 40 người chỉ đọc state: nội suy alpha, avatar fallback/cache, resize/onFrame, camera FINAL/rung, bia mộ hết hạn và hồi sinh reset dấu chết.
- [x] Effects từng event mẫu có particle/popup, hết hạn đúng, không vượt maxParticles và không sửa GameState.
- [x] HUD phase LOBBY/COUNTDOWN/BATTLE/FINAL/RESULT, popup ưu tiên có cap, feed 5 dòng, boss/energy/zone, top damage và API bảng ngày, không sửa state.
- [x] WebAudio đủ hit/kill/gift/boss/ultimate/countdown/win, mute/volume, xử lý autoplay bị chặn, cap voice khi spam và dispose.
- [x] Leaderboard day/week reset theo UTC, all-time và khóa chống trùng giữ qua ngày và reload JSON.
- [x] Shield từng lớp hết hạn độc lập sau khi tiêu hao; rage/speed/weapon tính qua chỉ số hiệu dụng có cap, không đổi chỉ số gốc.
- [x] Mỗi người hồi sinh tối đa một lần/ván và tổng không vượt maxRevivesPerRound; không hồi sinh được chuyển ultimate, quà thiếu/spectator phát gift:ignored.
- [x] Bot-only tự chạy và hoàn tất tối thiểu 5 vòng logic liên tiếp.
- [x] Headless 0, 1, 40 viewer: log phase và round:ended; class cân bằng, ID bot duy nhất.
- [x] COUNTDOWN nhận người, hàng chờ BATTLE khi đầy, vị trí đều quanh rìa, placement theo thứ tự loại và hồi sinh.
- [x] FINAL sớm giữ hạn tổng BATTLE + FINAL; hết giờ chọn HP cao nhất; tất cả chết thì hòa; một người không làm kẹt ván.
- [x] Chat, đủ 4 tier quà, chọn mục tiêu cứu, ultimate toàn sân, hồi sinh, liên minh và phản bội.
- [x] Bounty sau 3 mạng, boss spawn/damage/defeat, energy, bão, drop và trap.
- [x] Movement chỉ chạy BATTLE/FINAL: bounty, đồng minh, phản bội, giữ tầm cung/pháp sư, né x1.5 đúng hạn, separation, biên arena, vùng an toàn và ưu tiên nhặt drop.
- [x] Combat: shield hấp thụ chính xác, HP không âm, damage lồng nhau không phát chết trùng, buff cộng dồn, boost sát thương/tốc đánh, crit sau DEF, hồi sinh và bất tử ngắn.
- [x] Boss đánh từ CombatSystem đúng một lần mỗi interval, chọn mục tiêu gần nhất; ghi damage thực tế, không tính overkill, boss:defeated đúng một lần.
- [x] Zone nội suy đúng mốc kể cả nhảy thời gian, nghỉ giữa mốc, cảnh báo theo giai đoạn, damage mỗi giây, storm chỉ tăng damage ngoài bo và reset ván.
- [x] Event: energy LOBBY trì hoãn kích hoạt, drop:request/nhặt/hết hạn, drop tự động, bẫy điểm nóng, bombRain/meteor và chặn LOBBY/RESULT.
- [x] Boss cần ít nhất 4 người sống, chỉ một lần/ván, thưởng heal/rage cho top damage không trùng; ultimate bỏ qua bản thân/đồng minh và có hiệu ứng.
- [x] Alliance đồng thuận hai chiều trong 15s, tên không phân biệt dấu, phase/cooldown, lời mời quá hạn, bot chấp nhận/đề nghị và buff khi ghép.
- [x] Phản bội sớm bị từ chối; thứ tự betrayed -> damage -> broken, kể cả đòn gây chết; chết/RESULT làm vỡ liên minh và hai đồng minh cuối FINAL phải quyết đấu.
- [x] Bounty thuộc người có streak cao nhất, hòa giữ người hiện tại; claim thưởng heal/buff một lần, revive mở lại lượt tính streak, LOBBY reset.
- [x] Payload mock cho các loại `live:*` bắt buộc đúng kiểu dữ liệu.
- [x] 50 viewer join và 1.000 comment; số người chơi không vượt cấu hình.
- [x] Leaderboard cộng điểm và bỏ qua request ghi trùng.
- [x] Chế độ WebSocket local phát status đúng schema và dừng timer khi dispose.
- [x] WebSocket tự phát offline status rồi kết nối lại sau khi socket bị ngắt.
- [x] Event literal phía client thuộc catalog và các event nội bộ drop:request/gift:ignored.

## Audit event

- Emit không có listener trực tiếp: `cmd:giftTarget`, `streak:updated`, `trap:spawned`. HUD nay nghe boss:damaged, energy:changed, gift:ignored, player:joined, zone:update; Effects nghe drop:spawned. cmd:giftTarget được InputRouter cập nhật GameState trước khi emit; streak/trap còn được render hoặc đọc từ state.
- Listener không thấy emitter sau audit toàn client/server: **không có**. Audit nhận diện bus.on/emit/once/off, listen/safeEmit/emit và literal live:* trong adapter. Đường dẫn event động được kiểm tra thêm bằng payload runtime trong script mock và connector giả.
- Payload lệch được phát hiện và sửa: local `live:status` từng chứa cờ nội bộ `force`; cờ này nay bị loại trước khi emit. Schema live events và event literals hiện đều qua test.

Test stress chạy trong Node không đo FPS hoặc khả năng render Canvas; cần xác nhận phần đó trên máy chạy OBS/LIVE Studio.

Chạy riêng nghiệm thu RoundManager và factory:

```powershell
node --test --test-name-pattern="round manager|player factory" tests/game-smoke.test.js
```

Log 0, 1, 40 viewer có chuỗi `1:LOBBY -> 1:COUNTDOWN -> 1:BATTLE -> 1:FINAL -> 1:RESULT -> 2:LOBBY` và kết quả `round:ended`. Khi chỉ còn một người sống, ván chuyển thẳng từ BATTLE sang RESULT.

Người vào trong BATTLE/FINAL/RESULT được giữ ở `state.players` với status `spectator`, không tính trong ranking. Đầu ván sau, hàng chờ được ưu tiên trước người ván cũ, tối đa `maxPlayers`; phần dư tiếp tục chờ. Người thật được giữ giữa các ván, bot được tạo lại cuối LOBBY.

GiftEffectSystem bỏ qua tier1–3 cho người thiếu/spectator/dead; tier4 với người thiếu/spectator vẫn emit ultimate theo hợp đồng M8 mới. HUD dùng gift:ignored để ghi đúng trạng thái quà trong popup. InputRouter vẫn chưa cho spectator dùng CỨU; hành vi input này ngoài phạm vi M8/HUD.

## Movement Và Combat

```powershell
node --test --test-name-pattern="^movement:|^combat:" tests/game-smoke.test.js
```

Benchmark chạy 20 bot cân bằng lớp, fixed tick 30 Hz, seed 1/17/42, có RoundManager/M7/Zone/Movement/Combat và thưởng bounty, không có quà hay sự kiện ngẫu nhiên. Thời gian tính từ BATTLE đến RESULT: **83,57 / 81,50 / 112,70 giây**. Mỗi trận có một người thắng, 19 sự kiện player:killed cho 19 người khác nhau; mọi HP luôn trong [0, maxHp]. Đây là ba kịch bản tái lập, không phải cam kết mọi seed/quà/sự kiện đều kết thúc trong cùng khoảng.

Sát thương attack/boss/betray là `max(minDamage, atk * (1 + tổng bonus) - def)`, sau đó nhân crit cho attack. Bonus từ vũ khí, rage, boost và liên minh cộng dồn. Zone/trap/bomb/ultimate bỏ qua DEF; shield vẫn hấp thụ trước HP. Chỉ damage HP thực tế và damage boss thực tế được cộng damageDealt, không tính shield/overkill. Tank atk được cân bằng lại thành 21 để tránh đấu Tank chỉ gây sát thương tối thiểu với công thức trừ DEF.

EventSystem chỉ sinh drop/boss; MovementSystem nhặt drop và emit drop:collected; GiftEffectSystem áp thưởng; CombatSystem di chuyển/đánh boss và sở hữu HP. M7 (AllianceSystem hiện có) cập nhật streak/bounty qua player:killed; CombatSystem chỉ cộng kills. Khi hồi sinh, player có thể phát player:killed lần nữa ở lần chết kế tiếp, nhưng không phát trùng trong cùng một lượt sống.

## Zone Và Event

```powershell
node --test --test-name-pattern="^zone:|^events:" tests/game-smoke.test.js
```

`zone.stages[].atSec` tính từ BATTLE, không tính lại khi vào FINAL. Zone nội suy trong `shrinkSec` rồi giữ bán kính đến mốc kế tiếp. `zone:update` phát ở BATTLE để báo mốc đầu và khi bắt đầu từng giai đoạn; `shrinkAtMs` là timestamp bắt đầu co, không phát mỗi tick. Storm nhận qua event:triggered, cộng `events.list[].dps` vào damage ngoài bo trong durationSec, không gây damage cho người trong vùng.

Quà tier3 emit event nội bộ **drop:request { x?, y?, tier }**. EventSystem tạo drop:spawned, sinh thêm theo events.dropSpawnSec và quản lý hạn events.dropLifetimeMs; drop:collected gỡ drop và hạn tồn tại. Drop/bẫy/boss/ultimate không tạo hoặc gây damage ở LOBBY/RESULT; quà tier3 trong các phase này không được thả hàng. Energy vẫn tích lũy nhưng chỉ kích hoạt trong BATTLE/FINAL, và reset khi bắt đầu ván mới.

BombRain/meteor tạo các trap kind bomb với damage/radius theo sự kiện; bom nổ khi có người vào bán kính hoặc hết fuse. Bẫy thường ưu tiên điểm đông chiến binh. Boss chỉ một lần/ván, cần đạt cả events.bossMinAlive (mặc định 4) và minAliveToSpawn của cấu hình boss; top damager còn sống nhận heal + rage qua EventBus. Ultimate được EventSystem chuyển thành damage:request cho mọi kẻ địch toàn sân, bỏ qua mình và đồng minh; Effects nghe ultimate:fire để vẽ particles mà không thêm loại event ngoài catalog.

## Alliance Và Bounty

```powershell
node --test --test-name-pattern="^alliance:" tests/game-smoke.test.js
```

A và B phải cùng comment HỢP TÁC tên đối phương trong alliance.inviteTtlMs (mặc định 15s). Lời mời không tạo allianceId; chỉ khi đồng thuận mới lập cặp, mỗi người tối đa một đồng minh. Ghép ở LOBBY/COUNTDOWN/BATTLE, không ghép mới ở FINAL/RESULT. Buff atk/def/speed hiện có đọc từ allianceId; formationBuff phát thêm khiên ngắn qua buff:apply, không nhân lại buff sát thương/tốc độ.

Bot tự nhận lời theo botAcceptChance; botProposeChance và botProposeIntervalSec điều khiển lời mời bot -> người thật, người thật vẫn phải đồng ý. Không sinh lời mời hoặc tiêu thụ RNG lời mời trong trận chỉ có bot. Phản bội chỉ ở BATTLE/FINAL, chờ betrayWaitMs sau formedAt và có cooldown; damage được gửi trước khi gỡ liên minh. Nếu đòn phản bội gây chết, chỉ phát broken reason betray, không thêm death. Hai đồng minh cuối FINAL tự tách với alliance.finalBreakReason (mặc định roundEnd).

Streak tăng từ player:killed, không cộng kills lần nữa. Chỉ người sống đạt ngưỡng được mang bounty; streak cao hơn thay người hiện tại, bằng nhau giữ người hiện tại. Người hạ bounty còn sống nhận killerRewardHealPercent và killerRewardBuff qua EventBus; không có killer hợp lệ thì chỉ gỡ bounty. Sau claim có thể chọn lại người khác đã đủ streak. Sự kiện chết trùng trong cùng lượt sống không cộng streak/thưởng lần nữa; player:revived cho phép tính lần chết tiếp theo. RESULT gỡ cặp/lời mời, LOBBY reset streak/bounty.

## Gift Effects

```powershell
node --test --test-name-pattern="^gift effects:|gift tier 4" tests/game-smoke.test.js
```

Quà cộng tổng diamonds vào người tặng, không nhân lại count và không cộng cho rescue target. InputRouter tự join trước gift:effect. Chỉ BATTLE/FINAL áp hiệu ứng quà; LOBBY/COUNTDOWN/RESULT vẫn ghi giftValue nhưng phát gift:ignored reason inactive_phase.

T1 healAmount nhân min(count, gifts.maxHealCount), thêm speed ngắn; T2 thêm shield trừ người đang mang bounty nếu blockBountyGiftShield, tăng weaponLevel đúng một cấp đến combat.maxWeaponLevel. T3 gửi drop:request kèm x/y trong gifts.supplyScatterRadius quanh người nhận. T4 ưu tiên người nhận dead; nếu người nhận alive thì tìm người chết còn hợp lệ. Mỗi người một lần/ván, tổng gifts.maxRevivesPerRound; giới hạn được ghi nhận khi player:revived xác nhận. Không có người chết hợp lệ, hết lượt, hay target thiếu/spectator thì ultimate; người gửi thiếu không áp quà.

gift:ignored giữ fromId/toId/tier/diamonds/giftName/count và thêm reason (inactive_phase/missing_player/spectator/dead/unknown_sender). Không đổi payload gift:effect hoặc event catalog công khai.

Buff nằm trong player.buffs, có giới hạn thời gian gifts.maxBuffDurationMs và số lớp mỗi type. gifts.buffCaps chặn shield tổng, speed multiplier và tổng attack bonus (gồm rage/weapon/weaponLevel/boost/alliance). getEffectiveStats nằm trong core/utils để Movement/Combat dùng chung, không import chéo system và không sửa atk/speed gốc. Shield tiêu hao lớp cũ trước, mỗi lớp chỉ xóa phần còn lại khi hết hạn; shield mới không bị xóa theo hạn của shield cũ. Weapon upgrade là cấp vũ khí bền trong ván, không cộng lần nữa từ buff:apply durationMs=0.

Drop nhặt áp weapon/shield/heal/rage, chống thưởng lặp cùng id; LOBBY reset buff/shield, lượt revive và danh sách drop đã thưởng. dispose gỡ listener và update không còn thay đổi state.

## Renderer Và Effects

```powershell
node --test --test-name-pattern="^renderer:|^effects:|events: ultimate" tests/game-smoke.test.js
```

Renderer không ghi GameState: vị trí nội suy, camera, rung và thời điểm dấu chết chỉ lưu nội bộ. API có render(alpha), resize(), dispose(), onFrame(listener) trả hàm gỡ; update(dt) giữ tương thích để test/điều khiển hiệu ứng. main.js để renderer tiến thời gian effects theo frame rồi gọi HUD.update qua onFrame, không cập nhật effects thêm lần nữa trong tick logic. resize dùng kích thước state.arena; CSS canvas giữ tỷ lệ OBS 1080x1920.

Avatar cache LRU tối đa ui.avatarCacheMax: tải ảnh CORS anonymous, crop vuông giữa rồi clip tròn vào canvas offscreen, không clip từng nhân vật mỗi frame. Ảnh hỏng/đang tải/timeout dùng chữ đầu; nền/grid cũng cache offscreen. Màu, kích thước, icon lớp, zoom, thời gian chết và giới hạn hiệu ứng nằm trong config.ui.

Kiểm chứng trình duyệt local với 40 người, 4 avatar bitmap đã tải + 1 URL ảnh hỏng, HUD DOM qua onFrame và một lượt damage effects: 180 frame có **60,00 FPS**, render trung bình **0,53 ms**, p95 **1,00 ms**. Snapshot GameState trước/sau không đổi. Đã chụp desktop 1440x900 và mobile 390x844, kiểm tra canvas có pixel không trống, không overflow ngang; FINAL radius 120 zoom đúng 3x và avatar vẫn render. Đây là số đo trên trình duyệt hiện tại, chưa chứng nhận FPS trong OBS trên máy đích hoặc spam hiệu ứng kéo dài.

Effects nghe damage/kill/revive/buff/drop/trap/boss/ultimate/alliance/bounty. Damage popup có crit lớn hơn, kill có dòng tên, revive/drop có cột sáng, buff/bounty có aura, ultimate có sóng mở rộng toàn sân, ally có tim/tim vỡ. Tất cả spark/popup/ring/beam dùng chung cap maxParticles; LOBBY dọn effects, dispose gỡ listener và timer ảnh.

## HUD Và Audio

```powershell
node --test --test-name-pattern="^hud:|^audio:|^leaderboard:" tests/game-smoke.test.js
```

HUD là DOM overlay chỉ đọc state/event. Khung logic theo state.arena được scale/letterbox cùng Canvas; safeArea mặc định chừa top 6%, left 6%, right 14%, bottom 15%. Trên 1080x1920, footer cách đáy **288px**, mép phải khoảng **151px**. LOBBY có JOIN, timer, số đã vào, ticker avatar, lệnh và mức quà; COUNTDOWN 5..1 và CHIẾN; BATTLE/FINAL có energy/zone/boss/bounty, top 5 damage và 5 dòng feed; RESULT có nhà vô địch hoặc hòa, đầy đủ ranking ván trong vùng cuộn và top 5 bảng ngày.

Popup chỉ một ô, tối đa ui.hud.popupQueueMax (mặc định 8), mỗi lượt popupDurationMs. Quà lớn được ưu tiên trước quà nhỏ trong hàng chờ; quá tải bỏ quà nhỏ, không ngắt popup đang hiện. Tên quá dài rút gọn theo config, bản đầy đủ ở title/ARIA. Feed riêng, không ghi thêm vào state.killFeed. DOM list chỉ dựng lại khi dữ liệu đổi và bảng damage cập nhật theo refreshMs, không dựng lại toàn bộ mỗi frame.

Bảng ngày dùng fetchTop({period:'day',metric:'wins',limit:5}) từ leaderboardClient trên cùng backend đã resolve; làm mới trong RESULT để nhận kết quả sau POST. Request có timeout/abort đến khi đọc xong JSON và xử lý offline. Store lưu atomic JSON, reset ngày/tuần theo **UTC**, giữ all-time qua restart.

Đã bơm event giả ở cả 5 phase, chụp 1080x1920/mobile390x844/desktop1440x900. COUNTDOWN trả 5/4/3/2/1; 30 quà nhỏ + quà lớn vẫn giữ queue 8 và ưu tiên Galaxy; feed đúng 5 dòng; popup/feed không giao nhau; tên không khoảng trắng dài vẫn nằm trong khung; RESULT có 40 dòng ván và 5 dòng ngày. Snapshot state không đổi. Desktop 180 frame với 40 nhân vật + HUD đo khoảng **59,0 FPS**, render p95 **0,9ms** trên trình duyệt hiện tại, chưa chứng nhận máy OBS đích.

Audio dùng oscillator/gain, volume mặc định từ config.audio, giới hạn maxVoices và eventMinIntervalMs. Countdown phát mỗi giây, win từ round:ended có winner. Bật bằng nút loa hoặc ?audio=1; URL chỉ yêu cầu resume, không vượt qua chính sách autoplay của trình duyệt. Nếu bị chặn, tương tác pointer/keyboard sẽ thử unlock lại. Đã thử mute/unmute và slider ở WebAudio thật với status running; test mô phỏng cả resume lỗi và event spam. ?connection=0 ẩn chỉ báo kết nối.

## Leaderboard Bền Vững

```powershell
node --test --test-name-pattern="^leaderboard" tests/game-smoke.test.js
```

Các test dùng mkdtemp và LEADERBOARD_FILE cho server con, không ghi mock vào data thật. Ba ván giả kiểm tra wins/kills/giftValue và loại bot; 20 request đồng thời qua hai store cùng file giữ đủ rounds và JSON parse được, không còn .tmp. Store đọc lại file mỗi thao tác dưới khóa theo đường dẫn, do đó reload không mất điểm/dedup. Day đổi sau nửa đêm UTC; week đổi thứ Hai UTC, all-time giữ nguyên. Mỗi bucket có userId/name/avatar/wins/kills/damage/giftValue/rounds/lastSeen.

Test HTTP thực kiểm tra GET query, POST round:ended, bot không xuất hiện, 400 cho query/body sai và 413 khi quá 100KB. Validation từ chối negative/non-finite/type sai, duplicate playerId/placement và winner không đứng đầu. File hỏng được giữ nguyên và thao tác trả lỗi; không ghi trắng để che mất dữ liệu. Client test avatar/giftValue snapshot, không sửa state/payload event, fetchTop query, offline và dispose abort khi response body chưa xong.

Khóa chỉ chia sẻ trong một tiến trình Node; test không chứng nhận nhiều tiến trình cùng ghi một file. processedRounds giữ tối đa config.leaderboard.maxProcessedRounds (10.000); ngoài cửa sổ này việc gửi lại ván rất cũ có thể được cộng lại. API chưa có xác thực; chỉ mở trên mạng tin cậy, thêm auth/rate limit trước khi công khai internet.

## Main Và E2E Tự Động

```powershell
npm test
npm run test:audit
npm run test:e2e
```

scripts/mock-e2e.js dùng MockAdapter -> EventBus -> InputRouter -> các system, Effects và leaderboard transport giả ghi JSON ở thư mục tạm; không ghi điểm giả vào data thật. Script so khớp payload của mọi event phát trong các kịch bản với core/eventCatalog.js, kể cả lỗi listener đã bị EventBus bắt lại. Giai đoạn reconnect dùng HTTP/WebSocket thực, còn API leaderboard HTTP thực được kiểm tra trong npm test.

Thứ tự khởi tạo: config/state/bus/ws/input, Round/Movement/Combat/Zone/Event/Alliance/Gift, Renderer, HUD/Audio rồi LeaderboardClient. Thứ tự tick: Round/Gift/Alliance/Zone/Event/Movement/Combat. gameLoop chạy accumulator 30 Hz, giới hạn delta/steps, reset accumulator khi tab ẩn và disable từng system sau lỗi liên tục. RoundManager dịch deadline khi đồng hồ thực lệch sau pause; Zone đồng bộ cảnh báo theo deadline của owner. Không để main/renderer thay phase.

URL hỗ trợ local/debug/audio/w/h/transparent; w/h chỉ nhận số nguyên an toàn trong 1..runtime.maxArenaDimension (4096), giá trị sai dùng mặc định. Canvas có kích thước ban đầu 1080x1920; HUD dùng designWidth/designHeight cố định, scale theo viewport nên đổi nguồn 720x1280 không làm vỡ chữ. transparent=1 xóa nền Canvas/body và backdrop HUD toàn màn hình, vẫn giữ các dải thông tin cần độ tương phản.

Kết quả tự động/local đã chạy:

- [x] 5 ván bot-only đầy đủ LOBBY -> COUNTDOWN -> BATTLE -> FINAL -> RESULT -> LOBBY, không lỗi.
- [x] 0 viewer thật: bot tự bù, tự đánh và chuyển ván.
- [x] 50 lượt join/1000 comment: nhận đúng tối đa 40. Browser kiểm tra 240 frame có 7 ván rút ngắn, 7 POST mock, đủ 5 phase, không lỗi payload/update. FPS trung bình 60,00, p95 frame 3,6ms.
- [x] Spam tiếp 4800 comment (20/frame): FPS cửa sổ 1 giây thấp nhất 59,98, trung bình 60,00, p95 1ms; không system bị disable. Số đo là trình duyệt hiện tại, không phải máy OBS đích.
- [x] T1/T2/T3/T4 có heal/speed/shield/weapon/drop/ultimate; kiểm tra hồi sinh riêng, popup có cap và không giao feed (test HUD + browser trước đó).
- [x] Đồng thuận liên minh, phản bội, streak/bounty/claim, boss/defeat/reward, storm, drop và ultimate chạy qua bus.
- [x] WebSocket offline -> reconnect thực; ván bot vẫn tiến trong khoảng mất kết nối.
- [x] Leaderboard snapshot được ghi sau ván; API HTTP/atomic/dedup/restart được kiểm tra bằng file tạm.
- [x] Soak tăng tốc 1800 giây logic: lượt chạy cuối 25 ván, listener ổn định 54, peak particle 160/240, drop 2, trap 18, player 20. Script assert giới hạn mỗi tick và reset giữa các ván.
- [x] URL local/debug/audio/w=720/h=1280/transparent đã mở thật: pixel nền alpha 0, backdrop HUD transparent, không overflow sau frame resize.

## Lỗi Đã Sửa

- Thứ tự constructor/leaderboard trong main chưa đúng yêu cầu: tách constructor khỏi danh sách tick, dùng fetchTop callback trì hoãn tới khi client đã được tạo.
- Timestamp frame 0 bị dùng như giá trị "chưa khởi tạo": gameLoop dùng null, có test alpha/tick ở 0/16,67/33,33ms.
- InputRouter lỗi liên tục chỉ log mãi: loop nay quản lý cả input và system, reset bộ đếm sau update thành công, bỏ qua sau systemErrorLimit.
- Đổi tab làm logic pause nhưng HUD deadline/zone warning cũ: sửa RoundManager và Zone, test pause 60s chỉ tiến một tick và còn deadline hợp lệ.
- URL độ phân giải quá lớn có thể tạo canvas/loop vẽ khổng lồ: chặn theo maxArenaDimension; HUD giữ thiết kế dọc độc lập với resolution.
- transparent=1 vẫn có backdrop HUD tối toàn màn hình: thêm CSS xóa backdrop trong mode transparent.
- Adapter TikTok dùng uniqueId khi thiếu userId: bỏ event thiếu ID thật. Connector giả kiểm tra userId, đủ loại LIVE và gift streak tổng unit*count.
- Audit regex cũ bỏ sót listener/emitter helper và adapter: nay nhận diện cả client/server. Không phát hiện tên sai hoặc payload lệch trong luồng mock sau sửa. Validator có test từ chối force trong live:status, buff enum sai, field thiếu và avatar/giftValue thêm sai vào round:ended. Avatar/giftValue chỉ enrich ở HTTP snapshot, không đổi payload bus.

Audit cuối: emit không có listener trực tiếp là cmd:giftTarget (M3 cập nhật giftTargets trước emit), streak:updated (HUD/renderer đọc Player.streak), trap:spawned (renderer đọc state.traps). Không có listener thiếu emitter. Hai event nội bộ được cho phép riêng: drop:request và gift:ignored.

## E2E Thời Gian Thực Và OBS

```powershell
$env:USE_MOCK = 'true'
npm start
# Soak Node 30 phút thực, in heap mỗi 5 phút; chưa chạy trong lượt nghiệm thu này:
node --expose-gc scripts/mock-e2e.js --realtime
```

Mở http://localhost:3000/ hoặc cổng đã cấu hình; dùng /mock.html trên cùng server để gửi quà. Node real-time không chứng nhận DOM/Canvas/heap Chromium. Trên máy OBS/LIVE Studio cần:

- [ ] Chạy 30 phút thực, đủ tối thiểu 5 ván; không lỗi console, không có frame tụt dưới 30 FPS.
- [ ] Bơm 50 viewer + spam, cả 4 tier quà và các event đặc biệt trong giao diện thật.
- [ ] Chụp heap/GC ở phút 5/15/30, so listener/particle/drop/trap/avatar cache; chỉ kết luận không leak sau khi kiểm tra trend sau GC.
- [ ] Tắt rồi mở lại server mock: game tiếp tục với bot, status đổi, reconnect thành công và bảng JSON không mất.
- [ ] Kiểm tra Browser Source 1080x1920, transparency, vùng an toàn, audio=1 và thao tác unlock nếu autoplay bị chặn.
- [ ] Kết nối TikTok LIVE thật; test thực tế SDK/network/OBS riêng với tài khoản đang LIVE.

Không tuyên bố đã chứng nhận 30 phút heap/FPS OBS chỉ từ soak tăng tốc. Bảng JSON tồn tại qua restart, day/week UTC tự reset, all-time giữ nguyên.
