function proofKeepDashes(flow) {
  flow.querySelectorAll('p, h1, h2, h3, h4, h5, h6, figcaption').forEach(function(block) {
    var ranges = [], start, end, count = 0;
    function finish() {
      if (count > 1) {
        var range = document.createRange();
        range.setStart(start[0], start[1]);
        range.setEnd(end[0], end[1]);
        ranges.push(range);
      }
      count = 0;
    }
    var walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function(node) {
        return node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR' ?
          NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    while (walk.nextNode()) {
      var node = walk.currentNode;
      if (node.nodeName === 'BR') { finish(); continue; }
      for (var i = 0; i < node.length; i++) {
        if (node.data[i] !== '-') { finish(); continue; }
        if (count === 0) start = [node, i];
        end = [node, i + 1];
        count += 1;
      }
    }
    finish();
    ranges.reverse().forEach(function(range) {
      var span = document.createElement('span');
      span.style.whiteSpace = 'nowrap';
      span.appendChild(range.extractContents());
      range.insertNode(span);
    });
  });
}
