export function ConsoleImage() {
  try {
    console.log(
      "%c 云散·飞花 v 1.6.0 %c  ©2026 By LuckClouds",
      "color: white; background: #00ffff; padding:5px 0;",
      "padding:4px;border:1px solid #00ffff;",
    );

    console.image = function (url, scale) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d");
        if (ctx) {
          c.width = img.width;
          c.height = img.height;
          ctx.fillStyle = "red";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0);
          const dataUri = c.toDataURL("image/png");

          console.log(
            `%c sup?`,
            `
          font-size: 1px;
          padding: ${Math.floor((img.height * scale) / 2)}px ${Math.floor((img.width * scale) / 2)}px;
          background-image: url(${dataUri});
          background-repeat: no-repeat;
          background-size: ${img.width * scale}px ${img.height * scale}px;
          color: transparent;
        `,
          );
        }
      };
      img.src = url;
    };

    console.image(
      "http://localhost:3001/api/images/background.jpg?t=1769135437",
      0.3,
    );
  } catch (error) {
    console.error("error:", error);
    return;
  }
}
