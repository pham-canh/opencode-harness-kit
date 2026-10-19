# btake — quay video nộp bài hackathon không cần ngồi bàn phím

`vrec` quay **toàn màn hình thật**, cần bạn ở bàn phím và bật
System Settings → Privacy & Security → Screen Recording (đó là cảnh báo
trên đĩa D của `vrec`). Đủ tốt để quay demo, nhưng không dùng được khi:

- bạn muốn **chạy không canh**, ví dụ quay 5 bản submit một lượt;
- ứng dụng cần thao tác nhiều lần mà tay bạn sẽ run;
- bạn quay lại nhiều lần để chỉnh lỗi, mỗi lần tốn thời gian ngồi yên.

`btake` điều khiển trình duyệt thật bằng Playwright: tự bấm nút, tự quay,
tự kiểm tra, tự báo notification khi xong. Không cần Apple Events.

```
tools/btake/
├── btake.py          # record · verify · contact · dub
└── README.md
```

Cần: `pip install playwright && playwright install chromium`, và `ffmpeg`
trong PATH (giống `vrec`).

---

## Vì sao phải đổi cách quay

Đây là phần quan trọng nhất, đọc kỹ trước khi quay bất cứ thứ gì.

### Screencast của Playwright không dùng được cho video nộp bài

Cách quay mặc định là `record_video=True`. Nó **không ghi theo thời gian** —
nó chụp khi phát hiện màn hình *đổi* (damage), rồi đóng dấu thời gian bằng đồng hồ.

Hai hệ quả, cùng một nguyên nhân:

**1. Kết quả thoáng qua có thể rơi lọt giữa hai frame.**

App hiện kết quả rồi tự reset trong vài giây. Nếu lúc chuyển trạng thái
không phát sinh *damage* đủ lớn, encoder sẽ **không có frame nào chứa khoảnh
khắc đó**. Video ra mắt trọn vẹn, mọi kiểm tra tự động đều xanh — nhưng mở ra
thì quay đúng màn reset.

Trong dự án VoiceCare, **4 lần quay bằng screencast, 3 lần hỏng** kiểu này.
Lần còn lại "đạt" cũng phải mở video ra mới thấy là sai. Ba lần mất công như
vậy là vì mỗi lần đều tin báo cáo của script thay vì nhìn hình.

**2. Giữ lâu hơn thì app càng xoá sạch kết quả.**

Nghĩ đơn giản là giữ camera lâu hơn sau khi đạt — sai. Thử giữ 6 giây thì
session đã reset xong. Rút xuống 2 giây thì kết quả vừa kịp xuất hiện.

### Cách đúng: chụp frame theo nhịp cố định

`btake` bỏ screencast, tự `page.screenshot()` **mỗi 100ms**:

```python
while True:
    await page.screenshot(...)      # mỗi 100ms, không quan tâm có damage hay không
    if chưa_bấm:  bấm_nút()
    elif chưa_xác_nhận: đọc_trạng_thái()
    elif đủ_thời_gian_giữ: dừng()
```

Mọi thời điểm đều là một frame, nên **thời điểm biết chắc kết quả đã xảy ra
chắc chắn nằm trong file**. Không có chỗ nào rơi lọt được nữa.

Hệ quả có luôn: **offset của lời dẫn lấy thẳng từ chỉ số frame lúc bấm nút** —
chính xác tuyệt đối, không trôi, không phải đoán. `report.json` trả về luôn
`narration_offset` để bạn `btake dub --offset` đúng bằng số đó.

---

## Dùng

```bash
cd ~/harness/tools/btake

# 1. Quay
python3 btake.py record \
  --url "https://app.example.com" \
  --click "RUN FULL DEMO" \
  --confirm 'VC-\d+' \
  --frame \
  --hold 30 \
  --out ~/devpost/myhack/video.mp4

# 2. Kiểm tra cơ học
python3 btake.py verify video.mp4 --expect-narration narration.mp3

# 3. NHÌN. Bắt buộc.
python3 btake.py contact video.mp4
open video.contact.png

# 4. Ghép lời dẫn
python3 btake.py dub video.mp4 \
  --narration narration.mp3 \
  --offset 6.0 \
  --out video-dubbed.mp4
```

### `--confirm` là điều quan trọng nhất

Script không click gì cả, chỉ gọi `page.screenshot()` rồi so khớp regex trên
text. Nên bạn phải tự trả lời: **"bằng chứng nào trên màn hình chứng minh app
đã làm xong việc?"**

Chọn thứ **đổi theo mỗi lần chạy**, không phải nhãn tĩnh:

| Tốt ✅ | Xấu ❌ |
|---|---|
| `VC-\d+` (mã booking) | `BOOKED` (nhãn có sẵn trên thanh stage) |
| `order #\d{5,}` | `Success` |
| `total: \$\d+\.\d\d` | `Thank you` |

Vì thanh stage (`LISTENING → UNDERSTANDING → BOOKED`) là **tĩnh**: nó luôn hiện
đủ các nhãn kể cả trước khi chạy. Khớp vào đó là tự báo đạt.

---

## Danh sách lỗi đã dính, và chốt chặn tương ứng

Tất cả đều xảy ra thật. Mỗi lỗi có một cái chốt trong `btake.py`.

| Lỗi | Biểu hiện | Chốt |
|---|---|---|
| Screencast mất frame đáng giá | Video đủ dài, mọi check xanh, nhưng không thấy kết quả | Chụp frame nhịp cố định, thay screencast |
| Tin nhãn tĩnh | `BOOKED=True` sau 4.8s, app thật cần lâu hơn | `--confirm` phải là giá trị **đổi** |
| State cũ sót lại | Khớp mã `VC-` của **lần trước** ngay khi vừa bấm | Ghi lại mã đang hiện trước khi chạy, đòi mã **khác** |
| Độ phân giải poll làm nói dối | Booking thật 5s, tôi báo 20–30s vì poll 12s | Frame 10fps cho độ phân giải 100ms |
| App render trong `<iframe>` | `locator()` trả 0 phần tử, script tưởng app chặn | `--frame` chuyển sang `frame_locator` |
| `page.content()` chỉ ~14KB | Script probe thấy app "trống" | Không dùng `content()` để kiểm app |
| Màn trắng đầu video | 4–17s màn "Loading..." vô nghĩa | `trim_white_lead` dò pixel, **không hardcode** |
| Audio chết giữa video | Audio 52.2s trong video 258s | `dub` pad bằng `apad` + cap `-t` |
| `apad` + `-shortest` | ffmpeg **treo vô hạn** | Dùng `-t <duration>`, không dùng `-shortest` |
| `ffmpeg -i` exit 1 | Script chết trước bước ghép | Luôn kèm `|| true` khi chỉ dùng để đọc |
| Check audio chỉ kiểm đuôi | Báo PASS khi chỉ còn 3s/34s lời dẫn | `verify` đòi `spoken >= expected - 1s` |
| Nút trắng-trên-trắng | Nút "RUN DEMO" trống, judge không thấy nút cần bấm | Đo `getComputedStyle`, tìm hiểu nguyên nhân |

---

## Kiểm cuối trước khi submit

```bash
python3 btake.py verify video.mp4 --expect-narration narration.mp3
python3 btake.py contact video.mp4 && open video.contact.png
```

`verify` xanh **không có nghĩa là video đúng**. Nó đo thời lượng, stream, tương
phản pixel. Nó **không biết kết quả có nằm trong hình hay không** — chỉ mắt
mới biết. Mọi lần hỏng thật trong dự án này đều qua được `verify`.

Đọc contact sheet **theo thứ tự**, ba câu hỏi:

1. Mở đầu có màn trắng / màn lỗi không?
2. Giữa video có thấy app **đang làm việc** không (không phải đứng yên)?
3. **Cái cuối cùng trên màn hình có phải kết quả không?** Không phải màn reset.

Câu 3 là câu đã bắt được 3 lần quay hỏng.

---

## Vì sao có cả `vrec` lẫn `btake`

Hai công cụ khác nhau, dùng chung một nguyên tắc: **thứ có thể hỏng thì hỏng
ngay trong 10 giây đầu**.

- `btake` khi app chạy được trên web, thao tác bằng nút — quay tự động, lặp lại
  được, không cần bàn phím.
- `vrec` khi cần quay thứ không phải web (terminal, app native, trình soạn) —
  phải ngồi bàn phím.

Video nộp bài nên thuộc loại thứ hai. Nếu video nộp bài của bạn cần ngồi yên
canh, nó sẽ hỏng — và `btake` là cách thoát ra khỏi vòng lặp đó.