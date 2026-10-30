// The customer pay page. payHtml_(data) returns the whole document; payClient_ runs in the browser.
// Bundled ahead of edge.js, so both are plain top-level functions in the same scope.
//
// The page shows the order, asks where the customer wants to pay and for the number they pay from, then the steps for that
// method in that method's colours, and a status timeline that follows the payment until it is confirmed. A confirmed order shows
// a receipt and, for a pay request, what was delivered. Everything is built with createElement and textContent, never markup.
//
// The delivered code is never in this document. After the status poll reports a delivered order the page fetches /receipt once
// (same origin, token-gated) and renders the code from that answer.

// Supplied brand logos (bKash, Nagad, Upay), 72px tall PNGs inlined so the page needs no extra request.
var PAY_LOGO_ = {
  upay: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEUAAABICAYAAACgEzj3AAAMIElEQVR42u1cbWwb5R3/+Wxf7Nh17MQxbVISx7RdUQuO034YqKENNA0So6pLw6TB6EAq/YK2vqCOCfYiBGVCQJm0actaaDfoPlDSUPhQQV+ikGhQRFIbEmBFdew0hMZt43PwW872eR+ce3IX24lzZye08EiRnPP/7ny/5//6e/7PKRKJRAo5ht/vJ5+jMRbX+9BqaPLZYrHklFNkA8Xv9yMaY8FxSQAARSlxowzyTCoNtLQiKzgZoPj9foQj0RsKiJkA0pVqM4ARgeIbGgbHJUGpNAAXv+FBAaUGl4iBopSorVk6dVioIRyXTGvIDwEQAODioCglOC4p8p+UyGRUGlmqyP9ddwqj0iAciRJgVAAQZVOSNSSbM54PB81rNR9R+MAg6Z6TGhNl055EMTIykpLqWIU/guOSoKmrYDmz6FixgOHBCEeiAABdqZb8L/WevONVyZ0pFUahT/wLZYk28l1YuRmM+ikkqJuKAoxWQ+OdHi/eOO3B8NU0KEvNWvxyow1b1lll51SKkZGR1FwvIgSkkt0BmhvIKvdtyXGwCnvBgOFn8sCxz/Hysa9QpleLvg+G4tjbuhK7W2+TrDFaDQ1KDqrG+J9zAgIAFfHfF8y38ID0Dvhw6OTFDEAAoEyvxqGTF9E74IOuVCvJ6Udj7FRInquW0Ck3dMl3Z5SluQHQKbfI+codh059WxCZGaOR1BPV3GD+cpRafticjA5+JjKrLC8jVUMlgxKn6ua/oKMV+cmVqBZGU2Kp1XnJTSjvKEiGzJvfulWVCIZyXy8YimPNMpMsk6WkqDFfH11VvzyjbFC1EwlqaUGiD3/+4/ctg61Km1POVqXF4/ctm3/zoSgluEQMYeUWBFU7cwLCqPaRbLEQIxyJQleqRdsTDqysMWR8v7LGgLYnHNCVaklSJylPuejxpuQmcHTKjdLk++R4RNkCVmEvSlbLh+ZwJIpTfaNwewIAALvNhOaGm8h3cu4pG5RcalrM+oe/Np/aCzWpEPeUneaDUmd1pLzvKcaYDsb041E2Jcu5q+SajWHiSPbMkFqPsHJLQc2HN52h4REcPjuaGRHZJBzVSdzf5Mg5WUUBRQjIkomtuWdzMtsNq1sJu1Uo3mP3oa9w7otrWVP9N0JxfBMqnax/pE1IUTNaLddVMBaP45LQ0goMjYzhq6HxrIDw9U/PwJWFyWjzAi518bpkKYua5scVt/ywQFkoTYlMJL6/tU8+g+YGoMJoQcPz58MTM9Y+ALBIS89v7UMcn2JxXnIlyY8KQh3w43Tf5ZxOli8IV1TrFkZTWM6cl5wh+ToJyVJnTsi6nf96bEbZMr0adUsWzS8opEqmlGCpVXmZUDn3MtGWuQIjrHWefuNCXuc0WOkFCsmUGlFqXV6iZYk26OLHQKk0BNR8wOEBibIpPPlPNy75w7Oe41hejpqlVbIYfUrOkmNE2ZK3uDm+F0b2eZKZCsHJ9qfV0CSlf3h/Jz787PKs9wiG4tjYsFg2J6ySzKdwSbCUHWHl5lkJbKHGaLkejCsfw3eK+8XLtFxc1D8yNDyC9o+u4dDJ/MN6taUUrY03y66UJVMHwrWf6tid0kgj5WZEqfXk/8++qcG7vZW4NHoFH352GcFQfMZIM11LdvxsGf74iGPh+RRKpYEufgzm+F7Z4TY4kcSb//0p/vTeI3M+t8Kgwsn996R9kMwVQkoub8olYgirW3PSknMZZSVK/PqBj/HXX/xnzuce2HGbbBqyoBktl4iBUe1DWLlZ9rWSY0r8fO1HWLlkNO9z/r3XgTWragvWgUUVYpGKH1fVBwqiMQDQaIniu4nSWU2m0IDIoiNzUY+Mah/iihWyfcxIanzG7++6fTFeetxeEKK6KKAINYbjkgirWzGhvCOjRWMu42NvAxaVRLJqx55tq7FlnVV2P0rRQZnufBPUTWDopxFRtqA0+T60XM+MHQrC8diRB+EZiZJwXGFQYZXVjJa1i8kyhqzOpWLmKdm0JKsGTZLIHJeERtFP6Ex16gJUKXGHwAmXHe29t2NFtQ51SxbhZpMCK+ssIga/2C2tkkDhaxIIu7EptWgBXNicnM0pi+gELj7Fvk+7TqHXdIrG5utKtXC53Rj0eLCp5V5QKg24RAxD/gDGrl1BeUUlapZWZcyqCKTpWsX/zyURTmRq23w2O0v2KR0dxzHQ34+uri6UGcsQZ1lEIlEwTHoZs9Zqxb59T4miw/XSxS05T7HV2QAAw8OXMNDfjwsXLmB4+BL5fqC/H28fe2tOPbczVc287GwyhejnVUntKNq+fTvs9fUY9HjSEcJshsGQ7gQ4cvgwWHYCQHq3hG94FFwiRmgDnaAaFqbluZZDhX5qNhmRvMTlU8nm43Kne9nqbDbR8fHxdNJF0yUIMAF8cOpUho8Z8qdNrKLcJHrIoeEReAezUwUGgwH1djtcbje5x4w0qMGA5ctXSNpnoJJKDb564BWw7ARouiTN2U5qBg8IALjOn0dPdzceeuhhVJTfi4MH2+Ad9KYzXyYAo9EEa50VDQ1rcFdjIzrPnMJ7770LvV4vum8oFIJer8ezz72AI4cPY3j4UoZMtvHbZ/bj1mXVc14+laQp18YCmVzsJBC5xsGDbejp7iYPEwqFwLIT8Psv45NzH6OvrxcAsj6sXq+H0Zhu2SozlhFnzk9GrntPhK8CqC6u+VCUEtEYi0qzGbt27xGp8Zkzp+HzemE0mrD1gQdE51nrboHL7SIPXO9woLamFr4hH7yDXjBMAK7z50XnNDXdjTqbDcfb20UgxNkprqTe4cCGDU2i3yGUT6qM8xSSJ/fIuF0uBJgAWu5rxfo7Hejr68VAfz9qrVZsE4Di9/thsVjQa6+Hz5s2HZPRhJ07d5LdI729n+L11w6JQbmnGWsb6tHX14tPzl0mPkhN08ScvINeDNakcyXeN/X19cJ1PjB/eQrHJaHT0BjyB9DZeRahUAgmowm3Lqsmah5kgni7vR0AMOjxwDPogdO5FU6nEy63Cz6vF52dZ9F0TzMqzWboSrUkagnH2LUrZKuJ0DycznT7R5AJgmECOHr0TXR1deH5/S/MKTIVrSDkzUG43YxhAqJZD4VCqLfXY1NzM2x1Nnx94X/kIbUaGh0dHThx4p28fVm93Y5Nzc34tM+FPzzzO+j1ejBMAEMjY2RyFgSUsWtXyOcAE4Df74fJaCJqzQ/eOQoHy8axfMVPAACv/uVVkS8xGk0i/5FBG5SbEI5E0dbWhq6uLgL6usZG1FSVE9NcEFDKKyqnQAmkH2Jb64MkZ7HW3QLv4EWRxvj9fngGPcTEXnnpRQKA0WjCrx59FG6XC52dZ/OOYkajCbt270G93Z5VVplgANTOQ/RhU6goN5FZ9Xm96OjogNPpxF2NjSRBO97eOzXDZjPCkShxtEJtaGq6Ow2otRZul2tW8/EOeok2lhnLMD4+jg+7u2EwGFBeUYkAE1iAKjkRg65Ui/Xr1+Po0Teh1+tx4sQ7pDDkHaDQJNasWUs+84lXrdUKp3Mr6u329EYEwcbGfIfP68U//v63WXOk+al9YiycTid8Qz6iygwTyPAHvFnwUWHPk/vQeeYUDAYDCaOk9qG1iE3EMpKxQCCAUChEfIq1zoqe7qmMVphRTwdHaObz0jIaZVPY9ZtdaGhYgzNnTos0xGg0weFwYFvrg6IHr1lahe3bt5NijacU+IrWUmkBTZfAaDSRB7LV2eDzelFrTXOyO3bsxIYNTeS3JFVGKBMMxsfHSQoQZIJwOByoWVoliaWTvWwq3ODIp//CQi8XyZTxQyeTQmF7KG+u048Jmbn3P/gAX375BRo3OslSB19xS62SZS2b5moJj7KpKapgjrMk3FLLg8WDwB/jC9O3Tp7DW6+9CJpWg6ZL8OxzL6TbMCbvL5XUUmk1tLxejskbC3kROSxbBhfLxRGOZO/zV8dGRH4lHEsR7ZJ6f62GTjNvhWjS44EoxL6e6dfIdd1NLfdi1erVJLSnaQJ5+5Jlb9bG9+CNFvyqgRwfMv2alMVikfWOgwUjlymlyKmGI1HZLe+USgOLxZI2Hy2tSKtOAVs75wuYgiyOUWrS+y96f8oP6WUys71chhK+o4gkUteZxsjVEIpSiuiPH18/NNvrh0QvqpKRgN1wL6r68ZVmwP8B5OKg6qgBggAAAAAASUVORK5CYII=',
  nagad: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGwAAABICAYAAAATWxDtAAABC2lDQ1BJQ0MgUHJvZmlsZQAAeJyVkLFOwlAUhr+LJILBOMjAwNCBgUWCDsaBCYaGzRRJKE5tKV2gbW5rfAHZGFjZiItvIK/ghomJg5OPQEh0NtdqysLAmb785885/zkgXgCydRj7sTT0ptYz+9rhJwKhOmA5UcjuEvD9nnjfzti/8gM3coA1UJE9sw+iCBS9hKuK7YQbiu/jMAZxrVjeGC0QA6DqbbG9xU4olX8KNMajO7XrLzcF1+92gBxQJsJAp6nuTyzBI1x9wcEs1ew5LCdQ+ki1ygJOHuB5lWrpT0JLWr9SFsgMh7B5gmMTTl/h6Pb/ETuyqXlldAICPEa4aLTxcaihcUGdcy5/AKbWPz8bOFjoAAAOhklEQVR42u1cbWxb53V+znvvJSmJsiwzrleRs9xI7IzFi2a0dhZ0mmf7xzZ4dZSk0n40gRsvCPxV18mGzViQKVxWYN0QJ3GU2hnSJl4cbLNmN7Zh7ANpA0XYkrlLVLUapkaSa2mkPFemKVkiKd6P9+wHeelLipQlWnLX5T4AAeJe3q/3vOec5zznvQRcuHDhwoULFy5cuHDhwoULFy5cuHDhwoULFy5c/F+GBMgdhZ8HQ3VC3MqQ2U+rKtGqvostava7a+A7Dj4Fxf5+40RTlWRSbEPYhnJHaWFQl9WrmBQ8y0wdsNJdwQ1EdIKnM+8J4if5FJTTHYAALACIN6xfDbLuB3ETmBoBrAUwBuLXA9HhfgmQANg12HIai1gKgNNdoReEoK8CABFa0l3Bb1FHbAAA4qHmFjB1aiR3ZB2N8v7m1YQ2Y5ijAPqBVgXoNV2DLQep6MwOuXW8fmXaqnnNV6c+pN+wrPyPiCJXw5/9ipri5zTQ3nIBMWNIww2ChRBLbSwBsIhAgliaVs1rPr8oNBYAQfTAiq8lG4nQ6tWEthDCMhG+WsWnoEgmxfWwJaLqAuBrn2l6SB9XxmePpDZXFXuWE0QRBu/OGPLi/IyFGkUEEvh4Gh0AwJCdEHQPiDsgP2l5TV0qrwKAeDD8Ihlordut/5VCdKSssXJeVv/fIx2JUPMFv0dpKxX+vJrQDN1C+u8bNtKUsol1+W+qmoqJPYmEk4FSByzXYIvwrEv7Gj11Zz1/pwZ5p/o58xGxwWyfj6mLFfyy/q/qv8+Emp/XiHbMl6toSozQlLLJW628qpuwpPQj/UrNWQZ6fD+NdlEHLMmkCGLLzWG3MNZ3AHF5X6NmG8u7a7Zf+Q1DCKIHSkY35n4ZsDZN76m5ZJ33nNCI9no1oZXLYxlDGuzh9aiVM9KUl53eqRAd0T8V+n66K9QmiK1bFeb/X1Bxwfoutqhb0WPGg+Ezfo/SZj6RhKjllwDApvCFNJ/PzsxYT4ij/mf8HuWgvT1pWH3M6GWNf1z1O2ai+LiZdzwXVnwttV0I+odS9+GpIWV2Wr5YdSD65CchPKqV560e89q65r2aSTv0L6an/A20MpPBf5GJb5byrPP7oh3bQ+Fuv0dpcxgq4ttpVHu+YN4nTPFHZop/sfjYlb+SBjP6y92LnmQLQI+bw26Rt67f3dyi6uJFbpCKd72s1ZOwJLNPoblO69kX27w9FH7eJhfmJP2h9mfp932fwpflDfqqvEGQ85A9Imopez+SX646EH37k0I+1MXH0HZB6LbiGeoEAcpWnT01pGZm5EclBzRgbfofX3hToEEcTBpW38roL9yn/+2lDkqID1Qoio7yTNJTQ0rOg8rCqPX+ieyE4HaCBBMARBYZ6jtzLNdmu9lJ2Zqr93qtufsWf41bXXNZDCYBInRbWe+iHdwgFa2RoSdhMXC5eJAl89mq3xvvuxH6bMZkfPRO9Ffv+91X3t9fZWkv6bCszJT5ETPey4Y0HlbVVMw0q4P29WanqRmER8uRGCn5Syt2jaT5FBQqZImLGoRIiXqyWAbLiwI3z31b9V/kznhYVs/jSfEEqgE0mRZwU4knxmecv/ZtFQfiwfBOrya0N35Sc/+jr7y/v6pOfSlnqOe8E9Fz2aIYeSVfm8lECFjHwGUGejQl+TiAx02z5k+dZMYOhbITwg6F8Yb1qysONTSdErFY0qFvNuaE6JFAbOicAPg0oPxWU3NtJq1qSxLeaDpVl7vmsrBEm8pvDYUvqqAN4suzQmvMhiHJfJaBHoXoSN679kcfjgfDZzLX6C/r/2YmI+LK9y3mp6r3R486ZSe6B8T/mZW0jOP19VL6JzwrFAUA9BuWJZnPgrkzl89OEFFLpsZT6780kgEAEYGUAE2Gwv+hgjZUMngG5GFI9STIelUj2mEX7hlDGiZ4gMG7A9Hh/ngwfMbef7swmI8FYkOHJFpVsUBhWyxW0fjNUPMGFbTBqwmNVnJ5XY/x5g+1jT72yJMNmY8/oGviNSn5S9X7o0dlJ4TdIxMRSOqAJSKQshNC25NIWMxP6Tcsy1ZKBNEDQogfAPT7zLxLn+Vf8+8ambWPX5JsztRIwvonm8XadaAJHqjRlI0axMV4MLxzaYsqHl22wvk79m+zvapSrrqOGGOOERhesy6p3fWTkTPprlAbM56rOhB92zheX28bqVxbJjljvVVqn69WHDI/Vnv1P69+bPLu5nttz7LzTvSq/wuGFCHm5Crm5CpDilCpD3NylcF8zDHT20E8WqMpG23VxYA8bEgRiotM64xutQGARtTt9C4DcnP+vMwXirczJ1ddqeKVBnO7wXzMgDx8VczWMydXCa9cc62KjmfvfeFtowXnsAfRSkAvQNxUKpISUQuzHLb3qWoqtmYoNi07ISw12aPtSSSy1DuRKDt7IpDyWSir//hKfPaVUH8xnc+SGYJWjcd15u8ChfXZvUbfLMYx69iUnOv47Qqh24oHw4UznWmbUyIzq8Rra4YGp3OR5dyV0NpfqoHvx4WzSx0PjA9O5HTUmxqoF6P+kcHJK6G16+5K4chNIxMC0vuI4uPt/pHhyTtTODM1zpf5JPNZQfSAtieRkAAhAtaQSEimYiZXGs8y5yjYZQLm1F9UxX6GMwzebGw6lxrkBelQc/4cgehwP6HbkgCVmDXf82rioG00NcUn4sEwJgmNcUZvIDp0KB5q3qxBXCxVlxafLx4M79RA3cVjVaMpG5MZ67sS+HwltL5i/S1jSIMnyXLWTAA1g/EmM/fnjCsEwBWJswXh1bE5TTO5c68p8TD5h58KBmviwfAZDeKi/YkHw2fioeaWOYPE1FgfGzo/o1tv25s0oh0a0Q4VtMHvUQ7GQ81PBqLD/SZ4oPiaxefLzNKzGlF32XFjRCptC4lKEqUt1srrQnWGKyI8Y9R6/5mBy5f2NXpsIy3GWHRPbk4S1pb04Amqzt3HVQDoKfEIAmAT1W86CUTeCBAXnV7nPCYQG3rIgNycyzntV8VsvZ3rNIi/WGjZoBHtzYdW8IDTyDlmeO5dbFErMdptKdwyKubkMW16tgnMnXfdp1bUGeaOLFskYF3JH4xkzyuIRgBgC3qsYiYbDzW3zNe2IdC3gbkTIld/PRaIDZ0LxIbO5TavzZ9HmA3MWDCzM8EDHi9vZ0avY8K/fhpQnPe9TAbrtS/wPfsBqgY9bE6h2GqRqgOxgdqqEb2i5XBMIrM6+Mul9ENzCsI3oQoA4Fl1fK5ElJOTmB5z1ld5xsjcnk3ctKFMLbXN71EOXg+FP4wHw2fWSF/C+TuV08NEaFzw80jlt3PkYq3zHA+jcs1z0R6mcnrYGY/lFTFV3ElOd4XaqAOL7lGZ1+tXCGILRCWVG/OHimHXRvXjg9ckQBGUrsO8mtBM8EAgOvxCXk0gbjIgN89DqEYyhjSKDerVhGYwH1uMKmFAHg6MD07kSMmYfT+1sViqErKxaIMJgCVAdbFY0mC+kM9jH2i1cyk+npn4xqcDdjG8kPNf2tfo0fYkEtmG5Fzt0JyC8H3g07LtGvRmH7hVKZdn7YHP5yuy7vdr6vMAthmQh0sdVh8bOu+sz2xjJQ2rT0Xq6cXlC/VkfvmEo0C2x/GOeFgPttgD9IYdFmlcWJk+RSnOZbV+5V9soxnH6+tlJ0TxjUomhU9BkZ0Qd39zVJ8+Evp8uUal8Z5G+VxC/Hq2mO/lcmE7TwAgLl4PhT/UiLozhjQI9AikerLcMwZiQ4fyhS7zsRnD/IOJKvz6QrzLnsQG84XA+OBEqqm57mfaXtmCHksCNKJk3glI74Ct23nf8bGxKsW2rug0WroruEvbExsoXmMvIpBO9pjuCrWVNdYosfiRqns1oc3o1tuBWH4lsFUqCois5pdf3JO/z+yintHA+OBEPBi+UCqPSYBElnCcK7fYqNQxCeLIjG6NaUR7QdwrARoxdN0OtYV1W6si0WtVEhbVRbojv4st6taxnlQ8GI6A0G3nMu+pas18Igm17mZOIaIWIvpBuiv0MsDfMmp9I2LXSNreP/GNTwf8NUrrfC0UY5RYO1WtZCBlxpAGiCML0T2nkXp0Rq/+upNiJw2rT6fMU7nCeWy+0F8YbntvSRIC0eF+AIemgsGnwbXVAuDTY2OZ4hCdaFh/V2C8d+KOruk4DSgPArJYHecGqagPZoTTaMVLBRbaSS4wliGNnHcdzarbC19nH29YvxrCbHAMqq1EvGgb02BuD8SGzt3KiwTA10PhD+1nNqQI2cQiAlAnWoUo0UcDAHusTPAAM0ZBHKnknYGK6rAHc8yMwbsLDDAuLPWva2CMEpdr9Ts/8yopfYoi3/JJ21hJw+oDK19faMKWAJ0GlMD44EQgOtxvG0uidVneJ4gAUqDXLH4bpwdbFAEwg096NaHllJM2ANsKSpHlNJg9IwLR4X67timg+m/5ZPq8psyp0RZCh0eJZ9/wAv/o0QvkHPBuW2hdyIwUAD8MWJ3Ikh17EPPKSAWtDZuhzre8vFiq2ooeUwIUiA6/MKNbR+3QfJMY9Vp3ZJkbULDUbWcp7cyrCS29Xif1XtOklayUC5XmFIR1SSEZFRA/UvUSNc3mpXzlKC/YBsNfJEInMyK3CokFSkq2L/YVr493+0eGJxcboq+rqWR4bCx1R9cl3nyIbLc0HmpuIdC3y3V8vZrQZlebkgOysASIC8s3oYpSMpKz07tc74e9is9pbeFp35qhj6exzDgNKLbKUenz0FLeSO6lvKedzAy30T6P/dR/+F6jb3a5jFXpeQsX69y5Y5fMYMWz5+ZLeotf+2AwH7PfurydQV1uo+Hnban2QmZPThbaBqZWIjSWCpd5mgu84fXxe3YnltGuMLql+5rsMhpsPreXAKWamusyGYfa7WixL1XIcHGbhlvIXzcw2pXs3zy4/ybwM/GwxfyhiutJLly4cOHChQsXLly4cOHChQsXLly4cOHChQsXLpYR/wsWNaOGtsZf8QAAAABJRU5ErkJggg==',
  bkash: 'data:image/png;base64,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'
};

var PAY_TEXT_ = {
  en: {
    pageTitle: 'Pay', plan: 'monthly plan', ref: 'Reference', amount: 'Amount', language: 'Language',
    expiresIn: 'Link expires in {time}', expiresSoon: 'This link is about to expire', cdH: 'h', cdM: 'm', cdS: 's',
    chooseTitle: 'How do you want to pay?', chooseHint: 'Pick one. You will see the steps for it next.',
    notReady: 'Not available yet', numberTitle: 'Your {method} number', numberTitleBank: 'Your mobile number',
    numberHint: 'The number you will send the money from. We use it to find your payment.', numberLabel: 'Mobile number', numberPlaceholder: '01XXXXXXXXX',
    next: 'Continue', saving: 'Saving…', change: 'Change method', editNumber: 'Change number', paidFrom: 'Paying from',
    stepsTitle: 'Steps', copy: 'Copy', copied: 'Copied',
    wOpen: 'Open the {method} app and choose Send Money.', wTo: 'Send to this number', wAmount: 'Enter the amount', wRef: 'Put this in the reference box', wPin: 'Confirm with your PIN. This page updates by itself.',
    wNoNumber: 'The seller has not added a {method} number yet. Message them, or pick another method.',
    bOpen: 'Send the amount by bank transfer from your bank app or at a branch.', bBank: 'Bank', bName: 'Account name', bNumber: 'Account number', bBranch: 'Branch',
    bAmount: 'Amount', bRef: 'Remarks or reference', bSlow: 'A bank transfer can take longer to show. Tap "I have paid" once you have sent it.',
    bNoAccount: 'The seller has not added bank details yet. Message them, or pick another method.',
    claimTitle: 'Already sent it?', trxLabel: 'Transaction ID (optional)', trxHint: 'From your confirmation message. It helps us find the payment faster.',
    trxLabelReq: 'Transaction ID', trxHintReq: 'From your confirmation message or receipt. The seller uses it to find your payment.', bRouting: 'Routing number',
    wPinManual: 'Confirm with your PIN, then tap "I have paid" below.', autoNote: 'Confirmed automatically once your payment arrives.',
    manualNote: 'The seller confirms this payment by hand, so it can take a little while.', m1m: 'Waiting for your payment. After you send it, tap "I have paid" below.',
    m1cm: 'You told us you paid. The seller will check and confirm it soon.',
    claim: 'I have paid', claimed: 'Reported. We will confirm it shortly.',
    t0: 'Order created', t1: 'Waiting for payment', t2: 'Payment received', t3: 'Confirmed', tExpired: 'Link expired', tCancelled: 'Link cancelled',
    m0: 'Pick how you want to pay to begin.', m1: 'Waiting for your {method} payment. Keep this page open.', m1b: 'Waiting for your payment. Keep this page open.',
    m1c: 'You told us you paid. We are checking for it.', m2: 'We received your payment and are confirming it.', m3: 'Payment confirmed. Thank you.', until: 'Active until {date}',
    mExpired: 'This payment link has expired. Please contact the seller to get a new one.',
    mCancelled: 'This payment link was cancelled. Please contact the seller if you still want to buy.',
    mClosed: 'This payment link is no longer open. If you already paid, your seller has it. Otherwise please contact the seller.',
    rTitle: 'Receipt', rRef: 'Reference', rAmount: 'Amount paid', rMethod: 'Method', rTrx: 'Transaction ID', rTime: 'Time', rCopy: 'Copy receipt', rPrint: 'Print',
    dTitle: 'Your order', dCode: 'Your code', dTos: 'Terms', dReview: 'Enjoying it? Leave a review', dDiscord: 'Review on Discord', dFacebook: 'Review on Facebook',
    dPending: 'Payment confirmed — your seller will deliver your order shortly', dFailed: 'Payment confirmed, but delivery hit a problem. Please contact the seller.',
    dDelivered: 'Delivered — check your messages from the seller', dLoading: 'Getting your order…', dNoCode: 'Payment confirmed. Your seller will send you the details.', dRetry: 'Could not load your order yet. This page will try again.',
    badNumber: 'Enter your 11-digit mobile number, like 01XXXXXXXXX.', failed: 'Could not save. Check your connection and try again.',
    notFound: 'Payment link not found.', secure: 'Payments are matched automatically by reference.', noJs: 'This page needs JavaScript to show the payment steps.'
  },
  bn: {
    pageTitle: 'পেমেন্ট', plan: 'মাসিক প্ল্যান', ref: 'রেফারেন্স', amount: 'টাকার পরিমাণ', language: 'ভাষা',
    expiresIn: 'লিংকের মেয়াদ আছে আর {time}', expiresSoon: 'এই লিংকের মেয়াদ শেষ হতে চলেছে', cdH: 'ঘ', cdM: 'মি', cdS: 'সে',
    chooseTitle: 'কীভাবে পেমেন্ট করবেন?', chooseHint: 'একটি বেছে নিন। এরপর ধাপগুলো দেখতে পাবেন।',
    notReady: 'এখনো চালু হয়নি', numberTitle: 'আপনার {method} নম্বর', numberTitleBank: 'আপনার মোবাইল নম্বর',
    numberHint: 'যে নম্বর থেকে টাকা পাঠাবেন সেটি দিন। এটি দিয়ে আমরা আপনার পেমেন্ট খুঁজে নেব।', numberLabel: 'মোবাইল নম্বর', numberPlaceholder: '01XXXXXXXXX',
    next: 'এগিয়ে যান', saving: 'সেভ হচ্ছে…', change: 'মাধ্যম বদলান', editNumber: 'নম্বর বদলান', paidFrom: 'পেমেন্ট করছেন',
    stepsTitle: 'ধাপসমূহ', copy: 'কপি', copied: 'কপি হয়েছে',
    wOpen: '{method} অ্যাপ খুলে সেন্ড মানি বেছে নিন।', wTo: 'এই নম্বরে পাঠান', wAmount: 'টাকার পরিমাণ দিন', wRef: 'রেফারেন্স ঘরে এটি লিখুন', wPin: 'পিন দিয়ে নিশ্চিত করুন। এই পেজ নিজে থেকেই আপডেট হবে।',
    wNoNumber: 'বিক্রেতা এখনো {method} নম্বর দেননি। তাঁকে মেসেজ করুন, বা অন্য মাধ্যম বেছে নিন।',
    bOpen: 'ব্যাংক অ্যাপ থেকে বা শাখায় গিয়ে ব্যাংক ট্রান্সফারে টাকা পাঠান।', bBank: 'ব্যাংক', bName: 'অ্যাকাউন্টের নাম', bNumber: 'অ্যাকাউন্ট নম্বর', bBranch: 'শাখা',
    bAmount: 'টাকার পরিমাণ', bRef: 'রিমার্কস বা রেফারেন্স', bSlow: 'ব্যাংক ট্রান্সফার দেখাতে একটু সময় লাগতে পারে। পাঠানো হলে "আমি পেমেন্ট করেছি" চাপুন।',
    bNoAccount: 'বিক্রেতা এখনো ব্যাংকের তথ্য দেননি। তাঁকে মেসেজ করুন, বা অন্য মাধ্যম বেছে নিন।',
    claimTitle: 'টাকা পাঠিয়ে ফেলেছেন?', trxLabel: 'ট্রানজেকশন আইডি (ঐচ্ছিক)', trxHint: 'কনফার্মেশন মেসেজ থেকে নিন। এতে পেমেন্ট দ্রুত খুঁজে পাওয়া যায়।',
    trxLabelReq: 'ট্রানজেকশন আইডি', trxHintReq: 'কনফার্মেশন মেসেজ বা রসিদ থেকে নিন। বিক্রেতা এটি দিয়ে আপনার পেমেন্ট খুঁজে নেবেন।', bRouting: 'রাউটিং নম্বর',
    wPinManual: 'পিন দিয়ে নিশ্চিত করুন, তারপর নিচের "আমি পেমেন্ট করেছি" চাপুন।', autoNote: 'পেমেন্ট এলে নিজে থেকেই নিশ্চিত হবে।',
    manualNote: 'বিক্রেতা নিজে হাতে এই পেমেন্ট নিশ্চিত করেন, তাই একটু সময় লাগতে পারে।', m1m: 'আপনার পেমেন্টের অপেক্ষায়। পাঠানোর পর নিচের "আমি পেমেন্ট করেছি" চাপুন।',
    m1cm: 'আপনি পেমেন্ট করেছেন বলে জানিয়েছেন। বিক্রেতা দেখে শীঘ্রই নিশ্চিত করবেন।',
    claim: 'আমি পেমেন্ট করেছি', claimed: 'জানানো হয়েছে। শীঘ্রই নিশ্চিত করা হবে।',
    t0: 'অর্ডার তৈরি', t1: 'পেমেন্টের অপেক্ষা', t2: 'পেমেন্ট পাওয়া গেছে', t3: 'নিশ্চিত', tExpired: 'লিংকের মেয়াদ শেষ', tCancelled: 'লিংক বাতিল',
    m0: 'শুরু করতে পেমেন্টের মাধ্যম বেছে নিন।', m1: 'আপনার {method} পেমেন্টের অপেক্ষায়। পেজটি খোলা রাখুন।', m1b: 'আপনার পেমেন্টের অপেক্ষায়। পেজটি খোলা রাখুন।',
    m1c: 'আপনি পেমেন্ট করেছেন বলে জানিয়েছেন। আমরা খুঁজে দেখছি।', m2: 'আপনার পেমেন্ট পেয়েছি, নিশ্চিত করা হচ্ছে।', m3: 'পেমেন্ট নিশ্চিত হয়েছে। ধন্যবাদ।', until: '{date} পর্যন্ত চালু',
    mExpired: 'এই পেমেন্ট লিংকের মেয়াদ শেষ হয়ে গেছে। নতুন লিংকের জন্য বিক্রেতার সঙ্গে যোগাযোগ করুন।',
    mCancelled: 'এই পেমেন্ট লিংক বাতিল করা হয়েছে। এখনো কিনতে চাইলে বিক্রেতার সঙ্গে যোগাযোগ করুন।',
    mClosed: 'এই পেমেন্ট লিংক আর খোলা নেই। আপনি পেমেন্ট করে থাকলে বিক্রেতার কাছে তা আছে। না হলে বিক্রেতার সঙ্গে যোগাযোগ করুন।',
    rTitle: 'রসিদ', rRef: 'রেফারেন্স', rAmount: 'পরিশোধিত টাকা', rMethod: 'মাধ্যম', rTrx: 'ট্রানজেকশন আইডি', rTime: 'সময়', rCopy: 'রসিদ কপি করুন', rPrint: 'প্রিন্ট',
    dTitle: 'আপনার অর্ডার', dCode: 'আপনার কোড', dTos: 'শর্তাবলী', dReview: 'ভালো লেগেছে? একটি রিভিউ দিন', dDiscord: 'ডিসকর্ডে রিভিউ দিন', dFacebook: 'ফেসবুকে রিভিউ দিন',
    dPending: 'পেমেন্ট নিশ্চিত হয়েছে — বিক্রেতা শীঘ্রই আপনার অর্ডার পৌঁছে দেবেন', dFailed: 'পেমেন্ট নিশ্চিত হয়েছে, কিন্তু পৌঁছে দিতে সমস্যা হয়েছে। বিক্রেতার সঙ্গে যোগাযোগ করুন।',
    dDelivered: 'পৌঁছে দেওয়া হয়েছে — বিক্রেতার পাঠানো মেসেজ দেখুন', dLoading: 'আপনার অর্ডার আনা হচ্ছে…', dNoCode: 'পেমেন্ট নিশ্চিত হয়েছে। বিক্রেতা আপনাকে বিস্তারিত পাঠিয়ে দেবেন।', dRetry: 'এখনো আপনার অর্ডার আনা যায়নি। এই পেজ আবার চেষ্টা করবে।',
    badNumber: '১১ সংখ্যার মোবাইল নম্বর দিন, যেমন 01XXXXXXXXX।', failed: 'সেভ করা যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।',
    notFound: 'পেমেন্ট লিংক পাওয়া যায়নি।', secure: 'রেফারেন্স দিয়ে পেমেন্ট নিজে থেকেই মিলানো হয়।', noJs: 'পেমেন্টের ধাপ দেখাতে এই পেজে JavaScript লাগবে।'
  }
};

/** Script data goes in a JSON block, so nothing in it can close the tag or be read as markup. */
function payJson_(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * data: { lang, title, customerName, ref, amount, methods, intent, status, until, expires, kind, now }
 *   methods: Core.paylinks.methods(settings); intent: null | { method, number, claimed, trx }; status: { stage, rows, delivery? }
 *   kind: 'sale' (a subscription line) or 'request' (a pay request); expires: ISO time a request link lapses, or ''; now: server clock in ms.
 * The payload never carries a delivered code, only how delivery stands.
 */
function payHtml_(data) {
  var lang = data.lang === 'bn' ? 'bn' : 'en';
  var esc = function (s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var payload = { t: PAY_TEXT_[lang], all: PAY_TEXT_, lang: lang, title: data.title || '', customerName: data.customerName || '', kind: data.kind === 'request' ? 'request' : 'sale',
    ref: data.ref, amount: data.amount, methods: data.methods, intent: data.intent, status: data.status, until: data.until || '', expires: data.expires || '', now: data.now || 0, logos: PAY_LOGO_ };
  var css =
    ':root{color-scheme:light dark;--bg:#f3f1ec;--card:#fff;--ink:#16171c;--mut:#5c6070;--line:#e4e2dc;--soft:#f6f5f1;--ok:#0f7b4a;--okbg:#e2f5ea;--warn:#8a5a06;--warnbg:#fff3d6;--bad:#b3261e;--badbg:#fdeceb;' +
    '--b:#16171c;--bi:#fff;--bt:#ececf0;--ease:cubic-bezier(.16,1,.3,1);' +
    '--fd:"Iowan Old Style",Georgia,"Noto Serif Bengali",serif;--fb:-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif;--fm:ui-monospace,"SF Mono",Menlo,Consolas,monospace}' +
    '@media(prefers-color-scheme:dark){:root{--bg:#0d0e12;--card:#16181f;--ink:#f1f1f4;--mut:#a0a4b2;--line:#2a2d38;--soft:#1d2029;--ok:#5ee0a0;--okbg:#0f2f21;--warn:#f5bd45;--warnbg:#33260a;--bad:#ff8a80;--badbg:#3a1614;--b:#f1f1f4;--bi:#16171c;--bt:#232632}}' +
    '.m-bkash{--b:#e2136e;--bi:#fff;--bt:#fde7f1}.m-nagad{--b:#d9480f;--bi:#fff;--bt:#ffeadd}.m-upay{--b:#0a7ea4;--bi:#fff;--bt:#dff2f9}.m-bank{--b:#27408b;--bi:#fff;--bt:#e6ebf8}' +
    '@media(prefers-color-scheme:dark){.m-bkash{--bt:#3a1428}.m-nagad{--bt:#3a1c0c}.m-upay{--b:#0b86ad;--bt:#0b2c38}.m-bank{--b:#4a68c4;--bt:#16203d}}' +
    '*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--fb);line-height:1.45;padding:14px 14px 28px;display:flex;justify-content:center}' +
    '::selection{background:var(--b);color:var(--bi)}:focus-visible{outline:3px solid var(--b);outline-offset:2px}' +
    'main{width:100%;max-width:440px;display:grid;gap:12px;align-content:start}' +
    '.card{background:var(--card);border-radius:20px;box-shadow:0 1px 2px rgba(20,22,30,.06),0 14px 36px rgba(20,22,30,.1);overflow:hidden}' +
    '.bar{display:flex;justify-content:flex-end}.lang{display:inline-flex;border:2px solid var(--line);border-radius:999px;overflow:hidden;background:var(--card)}' +
    '.lang button{appearance:none;border:0;background:transparent;color:var(--mut);font:inherit;font-size:13px;font-weight:700;padding:8px 14px;min-height:36px;cursor:pointer}.lang button[aria-pressed=true]{background:var(--ink);color:var(--bg)}' +
    '.top{padding:20px 22px 4px}.top h1{margin:0;font-family:var(--fd);font-size:22px;font-weight:600;line-height:1.25;overflow-wrap:anywhere}.top .who{margin:3px 0 0;font-size:14px;color:var(--mut);overflow-wrap:anywhere}' +
    '.amt{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 22px 6px}.amt .v{font-family:var(--fd);font-size:42px;font-weight:700;letter-spacing:-.02em;line-height:1}' +
    '.inv{font-size:13px;font-weight:600;color:var(--mut);text-align:right}.inv b{display:block;color:var(--ink);font-family:var(--fm);font-size:15px;letter-spacing:.04em}' +
    '.cd{margin:0;padding:6px 22px 18px;font-size:13px;color:var(--mut)}.cd.soon{color:var(--warn);font-weight:700}' +
    '.track{list-style:none;margin:0;padding:16px 18px 6px;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px}' +
    '.track li{position:relative;text-align:center;font-size:12px;line-height:1.25;color:var(--mut);padding-top:22px}' +
    '.track li:before{content:"";position:absolute;top:6px;left:50%;width:11px;height:11px;margin-left:-5.5px;border-radius:50%;background:var(--line);transition:background .4s var(--ease),transform .4s var(--ease)}' +
    '.track li:after{content:"";position:absolute;top:11px;left:calc(50% + 9px);right:calc(-50% + 9px);height:2px;background:var(--line);transition:background .4s var(--ease)}.track li:last-child:after{display:none}' +
    '.track li.done:before,.track li.done:after{background:var(--ok)}.track li.cur:before{background:var(--b);transform:scale(1.35)}.track li.bad:before{background:var(--bad);transform:scale(1.35)}.track li.done,.track li.cur{color:var(--ink);font-weight:600}.track li.bad{color:var(--bad);font-weight:700}' +
    '.msg{margin:6px 18px 18px;padding:12px 14px;border-radius:12px;background:var(--soft);font-size:14px}.msg.ok{background:var(--okbg);color:var(--ok);font-weight:600}.msg.bad{background:var(--badbg);color:var(--bad);font-weight:600}.msg .sub{display:block;margin-top:2px;font-weight:400;color:var(--mut)}.msg.ok .sub{color:inherit;opacity:.85}' +
    'section.block{padding:18px 18px 20px}h2{margin:0 0 4px;font-family:var(--fd);font-size:18px;font-weight:600}.hint{margin:0 0 12px;font-size:13px;color:var(--mut)}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.tile{position:relative;appearance:none;border:2px solid var(--line);background:var(--card);color:var(--ink);border-radius:14px;padding:14px 12px;min-height:76px;text-align:left;font:inherit;cursor:pointer;transition:border-color .2s,background .2s,transform .2s var(--ease)}' +
    '.tile:hover:not(:disabled){border-color:var(--b)}.tile:active:not(:disabled){transform:scale(.98)}.tile[aria-pressed=true]{border-color:var(--b);background:var(--bt)}' +
    '.tile .dot{display:block;width:26px;height:26px;border-radius:8px;background:var(--b);margin-bottom:10px}.tile .logo{display:flex;align-items:center;height:28px;margin-bottom:10px}.tile .logo img{height:28px;width:auto;display:block}.tile .nm{font-size:16px;font-weight:800;color:var(--b);display:block}.tile .sm{font-size:12px;color:var(--mut);display:block;margin-top:1px}' +
    '.tile:disabled{opacity:.55;cursor:not-allowed}' +
    '.panel{background:var(--bt);animation:in .5s var(--ease) both}@keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
    '.band{background:var(--b);color:var(--bi);padding:12px 16px;font-weight:800;font-size:16px;display:flex;justify-content:space-between;align-items:center;gap:8px}' +
    '.band button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:600;text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:6px 0}' +
    '.pbody{padding:16px}.pbody+.pbody{padding-top:0}.pbody h3{margin:0 0 4px;font-size:15px}label{display:block;font-size:13px;font-weight:700;margin:12px 0 5px}' +
    'input{width:100%;font:inherit;font-size:17px;padding:12px 14px;border-radius:12px;border:2px solid var(--line);background:var(--card);color:var(--ink);caret-color:var(--b)}input:focus{border-color:var(--b);outline:0}' +
    '.btn{appearance:none;border:0;border-radius:12px;background:var(--b);color:var(--bi);font:inherit;font-size:16px;font-weight:800;padding:14px 16px;width:100%;margin-top:14px;cursor:pointer;min-height:48px;text-align:center;text-decoration:none;display:block}.btn:disabled{opacity:.6;cursor:wait}.btn.alt{background:var(--card);color:var(--b);border:2px solid var(--b)}' +
    '.err{margin-top:10px;font-size:13px;font-weight:600;color:var(--bad)}' +
    '.steps{list-style:none;margin:10px 0 0;padding:0;counter-reset:s}.steps li{counter-increment:s;display:flex;gap:12px;align-items:center;padding:11px 0;border-top:1px solid color-mix(in srgb,var(--b) 18%,transparent)}.steps li:first-child{border-top:0}' +
    '.steps li:before{content:counter(s);flex:none;width:26px;height:26px;border-radius:50%;background:var(--b);color:var(--bi);display:grid;place-items:center;font-size:12px;font-weight:800}' +
    '.steps .tx{flex:1;min-width:0;font-size:14px}.steps .big{display:block;font-size:17px;font-weight:700;margin-top:2px;overflow-wrap:anywhere}.mono{font-family:var(--fm);letter-spacing:.03em}' +
    '.kv{margin:10px 0 0;display:grid;gap:0}.kv div{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid color-mix(in srgb,var(--b) 18%,transparent)}.kv div:first-child{border-top:0}.kv dt{font-size:13px;color:var(--mut)}.kv dd{margin:0;font-size:16px;font-weight:700;text-align:right;overflow-wrap:anywhere}' +
    '.cp{flex:none;appearance:none;border:2px solid var(--b);background:var(--card);color:var(--b);border-radius:10px;font:inherit;font-size:13px;font-weight:700;padding:7px 12px;cursor:pointer;min-height:36px}.cp.done{background:var(--okbg);border-color:transparent;color:var(--ok)}' +
    '.note{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--card);font-size:13px;color:var(--mut)}.warn{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--warnbg);color:var(--warn);font-size:14px;font-weight:600}' +
    '.claim{margin-top:16px;padding-top:6px;border-top:2px dashed color-mix(in srgb,var(--b) 30%,transparent)}.claim h3{margin-top:12px}' +
    '.rc{padding:18px 18px 20px}.rc .msg,.rc .warn{margin:12px 0 0}.rc .kv{margin-top:6px}.rc .kv div{border-top-color:var(--line)}.rc .acts{display:grid;grid-template-columns:1fr 1fr;gap:10px}.rc .acts .btn{margin-top:14px;--b:var(--ink);--bi:var(--bg)}' +
    '.code{display:flex;gap:12px;align-items:center;justify-content:space-between;margin:10px 0 0;padding:14px;border-radius:12px;background:var(--soft);border:2px dashed var(--line)}.code .val{font-family:var(--fm);font-size:18px;font-weight:700;overflow-wrap:anywhere;user-select:all;min-width:0}' +
    '.tos{margin:14px 0 0;padding:12px 14px;border-radius:12px;background:var(--soft);font-size:13px;color:var(--mut);white-space:pre-wrap;overflow-wrap:anywhere}.tos b{display:block;color:var(--ink);margin-bottom:2px;font-size:13px}' +
    '.links{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}.links .btn{margin-top:8px;font-size:14px;--b:var(--ink);--bi:var(--bg)}.rv{margin:16px 0 0;font-size:14px;font-weight:700}' +
    '.offscreen{position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;font-size:16px}.foot{padding:4px 22px 6px;text-align:center;font-size:12px;color:var(--mut)}noscript{display:block;padding:18px;text-align:center}' +
    '@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}' +
    '@media print{body{background:#fff;color:#000;padding:0}.np{display:none!important}.card{box-shadow:none;border:1px solid #bbb;break-inside:avoid}}';
  return '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>' + esc(PAY_TEXT_[lang].pageTitle) + ' — ' + esc(data.title) + '</title><style>' + css + '</style></head><body>' +
    '<main id="app"><noscript>' + esc(PAY_TEXT_[lang].noJs) + '</noscript></main>' +
    '<script type="application/json" id="pay-data">' + payJson_(payload) + '</script>' +
    '<script>(' + payClient_.toString() + ')();</script></body></html>';
}

/** Runs in the customer's browser. Builds the page from the JSON block with textContent only, so nothing is parsed as markup. */
function payClient_() {
  var D = JSON.parse(document.getElementById('pay-data').textContent);
  var app = document.getElementById('app');
  var T = D.t;
  var NUM = /^(\+?88)?01\d{9}$/;
  var BASE = location.pathname.replace(/\/$/, '');
  // Poll gaps in ms: 5s, 10s, 20s, then 30s for good. A stage change or a user action starts the schedule again from 5s.
  var POLL = [5000, 10000, 20000, 30000];
  var saved = ''; try { saved = localStorage.getItem('payLang') || ''; } catch (e) {}
  if ((saved === 'en' || saved === 'bn') && D.all[saved]) { D.lang = saved; T = D.all[saved]; }
  var st = { lang: D.lang, method: D.intent ? D.intent.method : '', intent: D.intent, status: D.status, until: D.until, number: D.intent ? D.intent.number : '', trx: D.intent ? D.intent.trx : '', err: '', busy: false, editNumber: false,
    rcpt: null, rcptBusy: false, rcptTries: 0, rcptFail: false, seenAt: '' };
  var skew = D.now ? D.now - Date.now() : 0;
  var step = 0, pollTimer = null, tickTimer = null, cdEl = null, expPolled = false, etag = '';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function fill(s, vars) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? vars[k] : m; }); }
  function method(id) { for (var i = 0; i < D.methods.length; i++) if (D.methods[i].id === id) return D.methods[i]; return null; }
  function day(iso) {
    var d = new Date(String(iso).slice(0, 10) + 'T00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(st.lang === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function money(n) { return '৳' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function stage() { return st.status.stage; }
  function closed() { return stage() === 'expired' || stage() === 'cancelled'; }

  function copyText(value, done) {
    function fallback() {
      var a = document.createElement('textarea'); a.value = String(value); a.readOnly = true; a.className = 'offscreen';
      document.body.appendChild(a); a.select(); try { if (document.execCommand('copy')) done(); } catch (e) {} a.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(String(value)).then(done, fallback);
    else fallback();
  }
  function copyBtn(value, label) {
    var b = el('button', 'cp', label || T.copy);
    b.type = 'button';
    b.addEventListener('click', function () {
      copyText(value, function () { b.textContent = T.copied; b.classList.add('done'); setTimeout(function () { b.textContent = label || T.copy; b.classList.remove('done'); }, 1500); });
    });
    return b;
  }

  // ---- countdown ----
  function remaining() { return D.expires ? Date.parse(D.expires) - (Date.now() + skew) : NaN; }
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? h + T.cdH + ' ' + m + T.cdM : m + T.cdM + ' ' + (s % 60) + T.cdS;
  }
  function tick() {
    if (!cdEl) return;
    var left = remaining();
    if (isNaN(left)) return;
    if (left <= 0) { cdEl.textContent = T.expiresSoon; cdEl.className = 'cd soon'; if (!closed() && !expPolled) { expPolled = true; poll(); } return; }
    cdEl.textContent = fill(T.expiresIn, { time: clock(left) });
    cdEl.className = 'cd' + (left < 600000 ? ' soon' : '');
  }

  // ---- cards ----
  function langBar() {
    var bar = el('div', 'bar np');
    var g = el('div', 'lang'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', T.language);
    [['en', 'English'], ['bn', 'বাংলা']].forEach(function (l) {
      var b = el('button', '', l[1]); b.type = 'button'; b.id = 'lang-' + l[0]; b.lang = l[0]; b.setAttribute('aria-pressed', String(st.lang === l[0]));
      b.addEventListener('click', function () { setLang(l[0]); });
      g.appendChild(b);
    });
    bar.appendChild(g);
    return bar;
  }

  function summary() {
    var c = el('div', 'card');
    var top = el('header', 'top');
    top.appendChild(el('h1', '', D.title));
    var who = D.kind === 'sale' ? [D.customerName, T.plan].filter(Boolean).join(' · ') : D.customerName;
    if (who) top.appendChild(el('p', 'who', who));
    c.appendChild(top);
    var amt = el('div', 'amt');
    amt.appendChild(el('span', 'v', money(D.amount)));
    var inv = el('span', 'inv', T.ref); inv.appendChild(el('b', '', D.ref));
    amt.appendChild(inv);
    c.appendChild(amt);
    cdEl = null;
    if (D.kind === 'request' && D.expires && (stage() === 'created' || stage() === 'waiting' || stage() === 'claimed')) {
      cdEl = el('p', 'cd'); cdEl.id = 'countdown';
      c.appendChild(cdEl);
      tick();
    } else c.appendChild(el('div', 'cd'));
    return c;
  }

  function stageIndex(s) { return { created: 0, waiting: 1, claimed: 1, received: 2, confirmed: 3 }[s] || 0; }

  function status() {
    var c = el('div', 'card np');
    var ol = el('ol', 'track');
    var s = stage();
    if (closed()) {
      var first = el('li', 'done', T.t0);
      var last = el('li', 'bad', s === 'expired' ? T.tExpired : T.tCancelled); last.setAttribute('aria-current', 'step');
      ol.appendChild(first); ol.appendChild(last);
    } else {
      var idx = stageIndex(s);
      ['t0', 't1', 't2', 't3'].forEach(function (k, i) {
        var li = el('li', i < idx || s === 'confirmed' ? 'done' : i === idx ? 'cur' : '', T[k]);
        if (i === idx && s !== 'confirmed') li.setAttribute('aria-current', 'step');
        ol.appendChild(li);
      });
    }
    c.appendChild(ol);
    var m = method(st.intent ? st.intent.method : '');
    var manual = !!m && !m.auto;
    var text = { created: T.m0, waiting: m ? (manual ? T.m1m : fill(T.m1, { method: m.label })) : T.m1b, claimed: manual ? T.m1cm : T.m1c, received: T.m2, confirmed: T.m3, expired: T.mExpired, cancelled: T.mCancelled }[s] || T.m0;
    var box = el('div', 'msg' + (s === 'confirmed' ? ' ok' : closed() ? ' bad' : ''), text);
    box.setAttribute('role', 'status');
    if (s === 'confirmed' && st.until) box.appendChild(el('span', 'sub', fill(T.until, { date: day(st.until) })));
    c.appendChild(box);
    return c;
  }

  function chooser() {
    var sec = el('section', 'card block np');
    sec.appendChild(el('h2', '', T.chooseTitle));
    sec.appendChild(el('p', 'hint', T.chooseHint));
    var grid = el('div', 'grid');
    D.methods.forEach(function (m) {
      var b = el('button', 'tile m-' + m.id);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(st.method === m.id));
      b.disabled = !m.ready;
      if (D.logos[m.id]) { var lg = el('span', 'logo'); var li = el('img'); li.src = D.logos[m.id]; li.alt = ''; li.draggable = false; lg.appendChild(li); b.appendChild(lg); }
      else b.appendChild(el('span', 'dot'));
      b.appendChild(el('span', 'nm', m.label));
      if (!m.ready) b.appendChild(el('span', 'sm', T.notReady));
      b.addEventListener('click', function () { st.method = m.id; st.err = ''; st.editNumber = !(st.intent && st.intent.method === m.id); render(); });
      grid.appendChild(b);
    });
    sec.appendChild(grid);
    return sec;
  }

  function numberForm(m) {
    var body = el('div', 'pbody');
    body.appendChild(el('h3', '', m.id === 'bank' ? T.numberTitleBank : fill(T.numberTitle, { method: m.label })));
    body.appendChild(el('p', 'hint', T.numberHint));
    var lab = el('label', '', T.numberLabel); lab.setAttribute('for', 'num');
    var inp = el('input'); inp.id = 'num'; inp.type = 'tel'; inp.inputMode = 'numeric'; inp.autocomplete = 'tel'; inp.placeholder = T.numberPlaceholder; inp.value = st.number;
    inp.addEventListener('input', function () { st.number = inp.value; });
    body.appendChild(lab); body.appendChild(inp);
    if (st.err) { var e = el('div', 'err', st.err); e.setAttribute('role', 'alert'); body.appendChild(e); }
    var go = el('button', 'btn', st.busy ? T.saving : T.next); go.type = 'button'; go.disabled = st.busy;
    go.addEventListener('click', function () {
      if (!NUM.test(String(st.number).replace(/[\s-]/g, ''))) { st.err = T.badNumber; render(); return; }
      save({ method: st.method, number: st.number, claimed: false, trx: '' });
    });
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go.click(); });
    body.appendChild(go);
    return body;
  }

  function stepsFor(m) {
    var body = el('div', 'pbody');
    body.appendChild(el('h3', '', T.stepsTitle));
    if (m.id === 'bank') {
      if (!m.ready) { body.appendChild(el('div', 'warn', T.bNoAccount)); return body; }
      body.appendChild(el('p', 'hint', T.bOpen));
      var kv = el('dl', 'kv');
      [[T.bBank, m.bankName], [T.bName, m.accountName], [T.bNumber, m.accountNumber, true], [T.bBranch, m.branch], [T.bRouting, m.routing, true], [T.bAmount, money(D.amount), D.amount], [T.bRef, D.ref, true]].forEach(function (r) {
        if (!r[1]) return;
        var row = el('div'); var dt = el('dt', '', r[0]); var dd = el('dd', r[2] ? 'mono' : '', String(r[1]));
        row.appendChild(dt); row.appendChild(dd);
        if (r[2]) row.appendChild(copyBtn(r[2] === true ? r[1] : r[2]));
        kv.appendChild(row);
      });
      body.appendChild(kv);
      if (m.note) body.appendChild(el('p', 'note', m.note));
      body.appendChild(el('p', 'note', T.bSlow));
      return body;
    }
    if (!m.ready) { body.appendChild(el('div', 'warn', fill(T.wNoNumber, { method: m.label }))); return body; }
    var ol = el('ol', 'steps');
    function item(label, big, copyVal) {
      var li = el('li'); var tx = el('div', 'tx'); tx.appendChild(document.createTextNode(label));
      if (big) tx.appendChild(el('span', 'big mono', big));
      li.appendChild(tx);
      if (copyVal !== undefined) li.appendChild(copyBtn(copyVal));
      ol.appendChild(li);
    }
    item(fill(T.wOpen, { method: m.label }));
    item(T.wTo, m.number, m.number);
    item(T.wAmount, money(D.amount), D.amount);
    item(T.wRef, D.ref, D.ref);
    item(m.auto ? T.wPin : T.wPinManual);
    body.appendChild(ol);
    body.appendChild(el('p', 'note', m.auto ? T.autoNote : T.manualNote));
    return body;
  }

  function claimBox() {
    var box = el('div', 'claim');
    box.appendChild(el('h3', '', T.claimTitle));
    var cm = method(st.intent.method);
    var manual = !!cm && !cm.auto;
    var lab = el('label', '', manual ? T.trxLabelReq : T.trxLabel); lab.setAttribute('for', 'trx');
    var inp = el('input'); inp.id = 'trx'; inp.autocomplete = 'off'; inp.value = st.trx; inp.maxLength = 40;
    box.appendChild(lab); box.appendChild(inp); box.appendChild(el('p', 'hint', manual ? T.trxHintReq : T.trxHint));
    if (st.err) { var e = el('div', 'err', st.err); e.setAttribute('role', 'alert'); box.appendChild(e); }
    var done = st.intent && st.intent.claimed;
    var b = el('button', manual ? 'btn' : 'btn alt', done ? T.claimed : T.claim); b.type = 'button'; b.disabled = st.busy || !!done || (manual && !String(st.trx).trim());
    inp.addEventListener('input', function () { st.trx = inp.value; if (manual) b.disabled = st.busy || !!done || !String(st.trx).trim(); });
    b.addEventListener('click', function () { save({ method: st.intent.method, number: st.intent.number, claimed: true, trx: st.trx }); });
    box.appendChild(b);
    return box;
  }

  function panel() {
    var m = method(st.method);
    if (!m) return null;
    var p = el('div', 'card panel np m-' + m.id);
    var band = el('div', 'band'); band.appendChild(el('span', '', m.label));
    if (st.intent && st.intent.method === m.id && !st.editNumber) {
      var ch = el('button', '', T.editNumber); ch.type = 'button';
      ch.addEventListener('click', function () { st.editNumber = true; st.err = ''; render(); });
      band.appendChild(ch);
    }
    p.appendChild(band);
    var needsNumber = !(st.intent && st.intent.method === m.id) || st.editNumber;
    if (needsNumber) { p.appendChild(numberForm(m)); return p; }
    var from = el('div', 'pbody'); from.appendChild(el('p', 'hint', T.paidFrom + ': ' + st.intent.number));
    p.appendChild(from);
    p.appendChild(stepsFor(m));
    if (m.ready && stage() !== 'received' && stage() !== 'confirmed') { var cb = el('div', 'pbody'); cb.appendChild(claimBox()); p.appendChild(cb); }
    return p;
  }

  // ---- receipt and delivery ----
  function paidAt() {
    var rows = st.status.rows || [];
    var loc = st.lang === 'bn' ? 'bn-BD' : 'en-GB';
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i].date) {
      var raw = String(rows[i].date), d = new Date(raw.replace(' ', 'T'));
      if (isNaN(d)) return raw;
      return /\d[T ]\d/.test(raw) ? d.toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(loc, { dateStyle: 'medium' });
    }
    return st.seenAt ? new Date(st.seenAt).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }
  function receiptLines() {
    var m = method(st.intent ? st.intent.method : st.status.method || '');
    var lines = [[T.rRef, D.ref, true], [T.rAmount, money(D.amount)]];
    if (m) lines.push([T.rMethod, m.label]);
    if (st.intent && st.intent.trx) lines.push([T.rTrx, st.intent.trx, true]);
    var when = paidAt();
    if (when) lines.push([T.rTime, when]);
    return lines;
  }
  function receiptCard() {
    var c = el('div', 'card rc');
    c.appendChild(el('h2', '', T.rTitle));
    var lines = receiptLines();
    var kv = el('dl', 'kv');
    lines.forEach(function (l) { var row = el('div'); row.appendChild(el('dt', '', l[0])); row.appendChild(el('dd', l[2] ? 'mono' : '', String(l[1]))); kv.appendChild(row); });
    c.appendChild(kv);
    var acts = el('div', 'acts np');
    var plain = [D.title, ''].concat(lines.map(function (l) { return l[0] + ': ' + l[1]; })).join('\n');
    var cp = copyBtn(plain, T.rCopy); cp.className = 'btn'; acts.appendChild(cp);
    var pr = el('button', 'btn', T.rPrint); pr.type = 'button'; pr.addEventListener('click', function () { window.print(); });
    acts.appendChild(pr);
    c.appendChild(acts);
    return c;
  }
  function wantsOrder() { return D.kind === 'request' && stage() === 'confirmed'; }
  function deliveredCard() {
    var c = el('div', 'card rc');
    c.appendChild(el('h2', '', T.dTitle));
    var dl = st.status.delivery;
    var r = st.rcpt;
    // A custom link with nothing to deliver and no terms or review links has nothing to say here.
    if (r && !r.code && dl === '' && !r.tos && !(r.links && r.links.length)) return null;
    if (r && r.code) {
      c.appendChild(el('p', 'hint', T.dCode));
      var code = el('div', 'code'); code.appendChild(el('span', 'val', r.code)); code.appendChild(copyBtn(r.code));
      c.appendChild(code);
    } else if (dl === 'failed') {
      c.appendChild(el('div', 'warn', T.dFailed));
    } else if (dl === 'pending') {
      c.appendChild(el('div', 'msg ok', T.dPending));
    } else if (dl === 'delivered') {
      c.appendChild(el('div', 'msg ok', r ? T.dDelivered : st.rcptFail ? T.dRetry : T.dLoading));
    } else if (!r) {
      c.appendChild(el('div', 'msg', st.rcptFail ? T.dRetry : T.dLoading));
    }
    if (r && r.tos) { var tos = el('div', 'tos'); tos.appendChild(el('b', '', T.dTos)); tos.appendChild(document.createTextNode(r.tos)); c.appendChild(tos); }
    var links = ((r && r.links) || []).filter(function (l) { return l && typeof l.url === 'string' && l.url.indexOf('https://') === 0; });
    if (links.length) {
      c.appendChild(el('p', 'rv', T.dReview));
      var box = el('div', 'links np');
      links.forEach(function (l) {
        var a = el('a', 'btn', l.label === 'Discord' ? T.dDiscord : l.label === 'Facebook' ? T.dFacebook : String(l.label || ''));
        a.href = l.url; a.rel = 'noopener noreferrer'; a.target = '_blank';
        box.appendChild(a);
      });
      c.appendChild(box);
    }
    return c;
  }

  function render() {
    var active = document.activeElement && document.activeElement.id;
    app.textContent = '';
    document.documentElement.lang = st.lang;
    app.appendChild(langBar());
    app.appendChild(summary());
    app.appendChild(status());
    if (stage() === 'confirmed') {
      app.appendChild(receiptCard());
      if (wantsOrder()) { var dc = deliveredCard(); if (dc) app.appendChild(dc); }
    } else if (!closed()) {
      app.appendChild(chooser());
      var p = panel();
      if (p) app.appendChild(p);
    }
    app.appendChild(el('footer', 'foot np', T.secure));
    if (active) { var back = document.getElementById(active); if (back) back.focus(); }
  }

  function setLang(l) {
    if (l === st.lang || !D.all[l]) return;
    st.lang = l; T = D.all[l];
    try { localStorage.setItem('payLang', l); } catch (e) {}
    render();
  }

  // ---- network ----
  // The server says only 'closed' for a Paid or Cancelled link; the last polled stage tells which. Unknown stage gets a neutral text.
  function closedText() {
    var sg = st.status && st.status.stage;
    return sg === 'confirmed' ? T.m3 : sg === 'cancelled' ? T.mCancelled : T.mClosed;
  }
  function save(body) {
    st.busy = true; st.err = ''; etag = ''; render();
    fetch(BASE + '/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        st.busy = false;
        if (!d || !d.ok) {
          var why = String((d && d.error) || '');
          st.err = /expired/i.test(why) ? T.mExpired : /closed/i.test(why) ? closedText() : /cancel/i.test(why) ? T.mCancelled : why || T.failed;
          render(); step = 0; poll(); return;
        }
        st.intent = d.intent; st.status = { stage: d.status.stage, rows: d.status.rows, delivery: st.status.delivery || '', method: d.intent.method }; st.until = d.until || st.until; st.method = d.intent.method; st.number = d.intent.number; st.editNumber = false;
        render(); restart();
      })
      .catch(function () { st.busy = false; st.err = T.failed; render(); });
  }

  // Fetch the receipt once the order is confirmed: it carries the terms, the review links and, when a code was delivered, the code.
  // Again only if the code was not there yet and delivery has since become 'delivered'. At most four tries in all.
  function loadReceipt() {
    if (!wantsOrder() || st.rcptBusy || st.rcptTries >= 4) return;
    var needCode = st.status.delivery === 'delivered' && !(st.rcpt && st.rcpt.code);
    if (st.rcpt && !needCode) return;
    if (st.rcpt && st.rcpt.codeTried) return;
    st.rcptBusy = true; st.rcptTries++;
    fetch(BASE + '/receipt', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      st.rcptBusy = false;
      if (!d || !Array.isArray(d.lines)) { st.rcptFail = true; render(); return; }
      st.rcptFail = false;
      st.rcpt = { code: typeof d.code === 'string' ? d.code : '', tos: typeof d.tos === 'string' ? d.tos : '', links: Array.isArray(d.links) ? d.links : [], codeTried: st.status.delivery === 'delivered' };
      render();
    }).catch(function () { st.rcptBusy = false; st.rcptFail = true; render(); });
  }

  function settled() {
    var s = stage();
    if (s === 'expired' || s === 'cancelled') return true;
    if (s !== 'confirmed') return false;
    if (D.kind !== 'request') return true;
    var dl = st.status.delivery;
    if (!st.rcpt && st.rcptTries < 4) return false;
    if (dl === 'delivered') return !!(st.rcpt && (st.rcpt.code || st.rcpt.codeTried)) || st.rcptTries >= 4;
    return dl === '';
  }

  function schedule() {
    clearTimeout(pollTimer); pollTimer = null;
    if (document.hidden || settled()) return;
    pollTimer = setTimeout(poll, POLL[Math.min(step, POLL.length - 1)]);
  }
  function restart() { step = 0; schedule(); }

  // The poll sends the ETag of the last answer. 304 means unchanged: back off as for an unchanged answer, never an error.
  // A network error or a bad answer also backs off and the loop goes on: schedule() runs in every case.
  function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    fetch(BASE + '/status', { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} }).then(function (r) {
      if (r.status === 304) return { unchanged: true };
      var tag = r.headers.get('ETag'); if (tag) etag = tag;
      return r.json();
    }).then(function (d) {
      if (d && d.unchanged) { step++; loadReceipt(); return; }
      if (!d || !d.ok) { step++; return; }
      var changed = d.stage !== stage() || (d.delivery || '') !== (st.status.delivery || '');
      if (changed) {
        if (d.stage === 'confirmed' && stage() !== 'confirmed' && !st.seenAt) st.seenAt = new Date().toISOString();
        st.status = { stage: d.stage, rows: d.rows, delivery: d.delivery || '', method: d.method || '' }; st.until = d.until || st.until;
        step = 0; render();
      } else step++;
      loadReceipt();
    }).catch(function () { step++; }).then(schedule);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimeout(pollTimer); pollTimer = null; return; }
    step = 0; poll();
  });

  render();
  loadReceipt();
  tickTimer = setInterval(tick, 1000);
  schedule();
}
