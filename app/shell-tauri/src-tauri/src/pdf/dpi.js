function proofFigureDpi(width, height, orientation, placedWidth, placedHeight) {
  if (!(width > 0 && height > 0 && placedWidth > 0 && placedHeight > 0) ||
      ![width, height, placedWidth, placedHeight].every(Number.isFinite) ||
      !Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    throw new Error("invalid figure print geometry");
  }
  if (orientation >= 5) { var swap = width; width = height; height = swap; }
  var dpi = Math.min(width / placedWidth, height / placedHeight);
  return { dpi: dpi, warning: dpi < 300, flag: dpi < 200 };
}
